/**
 * Test-only fixtures for the boot restore pipeline: the agent binaries a resumed pane runs.
 *
 * Step 4 of the restore (agent-lifecycle.md §6.1, `boot/resume.ts`) types `codex resume <id>`
 * or `claude --resume <id>` into a REAL shell. On any machine that has the real CLIs installed
 * those names resolve, the agent starts, and it is then entitled to do what a full-screen
 * program does: switch to the alternate screen and repaint the pane. A test that reads the
 * pane's screen back to prove the command was typed is racing that repaint, and under load it
 * loses (packages/daemon/src/import/integration.test.ts, three of five battery runs on
 * 2026-09-07, where a real Codex painted its "Do you trust the contents of this directory?"
 * prompt over the line the test came to read).
 *
 * `writeAgentStubs` puts a `codex` and a `claude` of our own at the FRONT of the pane's PATH,
 * through the same `KELPID_HELPERS_DIR` seam the shell uses to ship the bundled `kelpi` CLI
 * (`boot/compose.ts`), so a restored pane resolves them instead of whatever is installed. Each
 * stub prints its argv, appends the same argv to a log the test can read, and then holds the
 * pane open on stdin the way a live agent would, without ever repainting it. The screen
 * therefore keeps exactly what was typed plus what the stub echoed, for as long as the test
 * cares to look, and the log is a second, screen independent record of the command line the
 * restore actually composed.
 *
 * Nothing in the daemon runtime imports this; only `*.test.ts` does, the convention
 * `store/testing.ts` and `handlers/pane/testing.ts` already follow.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface AgentStubs {
    /**
     * The directory to hand a daemon as `KELPID_HELPERS_DIR`. It is prepended to every pane's
     * PATH, so the stubs shadow any real `codex` / `claude` on the machine.
     */
    readonly dir: string;
    /** One line per `codex` invocation, holding that invocation's arguments. */
    readonly codexLog: string;
    /** One line per `claude` invocation, holding that invocation's arguments. */
    readonly claudeLog: string;
}

/** The kinds `resumeCommand` can produce a command line for (@kelpi/core/agent). */
const AGENT_KINDS = ['codex', 'claude'] as const;

/**
 * Write stub `codex` and `claude` executables under `root`, ready to be put on a pane's PATH.
 *
 * `exec cat > /dev/null` is what keeps the pane occupied: the stub stays in the foreground
 * like a real agent session, produces no further output, and dies with the PTY rather than on
 * a timer, so nothing survives the test.
 */
export function writeAgentStubs(root: string): AgentStubs {
    const dir = path.join(root, 'agent-bin');
    fs.mkdirSync(dir, { recursive: true });
    const logFor = (kind: string): string => path.join(root, `${kind}-argv.log`);

    for (const kind of AGENT_KINDS) {
        const script = [
            '#!/bin/sh',
            `printf '%s\\n' "${kind}-stub $*"`,
            `printf '%s\\n' "$*" >> "${logFor(kind)}"`,
            'exec cat > /dev/null',
            ''
        ].join('\n');
        fs.writeFileSync(path.join(dir, kind), script, { mode: 0o755 });
    }

    return { dir, codexLog: logFor('codex'), claudeLog: logFor('claude') };
}

/**
 * The argument lines a stub logged, oldest first. Empty when it was never invoked (the log
 * file only exists once something ran it).
 */
export function stubArgv(logPath: string): string[] {
    try {
        return fs
            .readFileSync(logPath, 'utf8')
            .split('\n')
            .filter((line) => line.length > 0);
    } catch {
        return [];
    }
}

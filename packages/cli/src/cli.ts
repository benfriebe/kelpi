/**
 * The top-level dispatcher (cli.md §3).
 *
 * Quirks that are contract, not accidents:
 *   - no arguments at all prints the usage block to **stderr** and exits 1;
 *   - `--help` prints the same block, still to **stderr**, and exits 0;
 *   - `--version` prints `kelpi <version>` to stdout;
 *   - an unknown subcommand prints `Unknown command: <x>` then the usage block, exit 1.
 */

import { isHelpToken } from './args.js';
import { setEnv } from './env.js';
import { exit, printLine, writeErr } from './io.js';
import { handleDoctor } from './commands/doctor.js';
import { handleEvent } from './commands/event.js';
import { handleGraft } from './commands/graft.js';
import { handleGroup } from './commands/group.js';
import { handleInstallHooks } from './commands/install-hooks.js';
import { handleLayout } from './commands/layout.js';
import { handleDiff, handleMarkdown, handleOpen } from './commands/openmd.js';
import { handlePane } from './commands/pane.js';
import { handleWeb } from './commands/web.js';
import { handleWorkspace } from './commands/workspace.js';
import { resolveTransport, setTransport } from './transport.js';
import { globalUsage } from './usage.js';
import { resolveCliIdentity } from './version.js';

/** Wire the process environment into the modules that cache it (also used by tests). */
export function configure(environment: NodeJS.ProcessEnv): void {
    setEnv(environment);
    setTransport(resolveTransport(environment));
}

export async function run(argv: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    configure(environment);
    const args = [...argv];
    const subcommand = args.shift();
    if (subcommand === undefined) {
        writeErr(globalUsage);
        exit(1);
    }

    if (subcommand === '--version' || subcommand === 'version') {
        printLine(`kelpi ${resolveCliIdentity(environment).version}`);
        exit(0);
    }
    if (isHelpToken(subcommand)) {
        // Deliberately stderr, exit 0 (a shipped quirk).
        writeErr(globalUsage);
        exit(0);
    }

    switch (subcommand) {
        case 'event':
            return handleEvent(args);
        case 'pane':
            return handlePane(args);
        case 'workspace':
            return handleWorkspace(args);
        case 'group':
            return handleGroup(args);
        case 'layout':
            return handleLayout(args);
        case 'open':
            return handleOpen(args);
        case 'md':
            return handleMarkdown(args);
        case 'diff':
            return handleDiff(args);
        case 'graft':
            return handleGraft(args);
        case 'web':
            return handleWeb(args);
        case 'doctor':
            return handleDoctor(args);
        case 'install-hooks':
            return handleInstallHooks(args);
        default:
            writeErr(`Unknown command: ${subcommand}\n`);
            writeErr(globalUsage);
            exit(1);
    }
}

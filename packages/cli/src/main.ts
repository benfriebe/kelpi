/**
 * Entry point. Everything interesting is in `cli.ts`; this file owns process concerns only.
 *
 * `process.exit` is deliberately never called: on macOS a piped stdout is asynchronous, so
 * exiting eagerly can truncate the bytes a shell pipeline (`kelpi pane capture | grep …`) is
 * still reading. `ExitError` carries the code up here, we set `process.exitCode`, and Node
 * flushes and exits once the loop drains — every socket having been destroyed on the way out.
 *
 * A closed stdout (`kelpi pane capture | head -1`) surfaces as EPIPE; that is the reader's
 * choice, not a CLI failure, so it is swallowed.
 */

import { run } from './cli.js';
import { ExitError } from './io.js';

function ignoreEPIPE(stream: NodeJS.WriteStream): void {
    stream.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE') return;
        throw error;
    });
}

ignoreEPIPE(process.stdout);
ignoreEPIPE(process.stderr);

try {
    await run(process.argv.slice(2), process.env);
    process.exitCode = 0;
} catch (error) {
    if (error instanceof ExitError) {
        process.exitCode = error.code;
    } else {
        process.stderr.write(`kelpi: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

/**
 * `kelpi ps` (cli.md "Running services", docs/running-services.md): the dev servers, listening processes and
 * Docker containers running on the daemon's host, each listed under the workspace whose pane
 * started it. A read: the daemon scans when asked.
 *
 * Warnings (a probe that could not run, such as Docker timing out) go to stderr and never change
 * the exit code, so `--json` on stdout stays one parseable array.
 */

import { hasHelpFlag, parseFlag, popSwitch, rejectLeftoverArgs } from '../args.js';
import { homeDirectory, rawPaneID, replyTimeoutSeconds, requirePaneID } from '../env.js';
import { errLine, exit, printLine, writeOut } from '../io.js';
import { asString, stableStringify, type JsonObject } from '../json.js';
import { decodeReply } from '../reply.js';
import { printServicesTable, replyArray } from '../table.js';
import { psUsage } from '../usage.js';

/** A scan runs four probes with a 3-second cap each; give the reply room beyond the default. */
const PS_REPLY_TIMEOUT_SECONDS = 15;

export async function handlePs(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(psUsage);
        exit(0);
    }
    const workspace = parseFlag('--workspace', args);
    const currentOnly = popSwitch('--current', args);
    const all = popSwitch('--all', args);
    const asJSON = popSwitch('--json', args);
    const noHeader = popSwitch('--no-header', args);
    rejectLeftoverArgs(args, 'kelpi ps', { usage: (write) => write(psUsage) });

    if (workspace !== null && currentOnly) {
        errLine('kelpi ps: --workspace and --current are mutually exclusive');
        exit(1);
    }

    // Outside a pane there is no current workspace: an empty list, still parseable with --json
    // (a script piping `kelpi ps --current --json` into jq must not get an empty string).
    if (currentOnly && rawPaneID() === undefined) {
        if (asJSON) printLine('[]');
        exit(0);
    }

    const payload: JsonObject = { command: 'running-list' };
    if (workspace !== null) payload['workspace'] = workspace;
    if (currentOnly) {
        payload['pane_id'] = requirePaneID();
        payload['scope'] = 'current';
    }
    if (all) payload['all'] = true;

    const reply = await decodeReply(payload, 'kelpi ps', {
        timeoutSeconds: Math.max(replyTimeoutSeconds(), PS_REPLY_TIMEOUT_SECONDS)
    });
    for (const warning of Array.isArray(reply['warnings']) ? reply['warnings'] : []) {
        const text = asString(warning);
        if (text !== undefined) errLine(`kelpi ps: warning: ${text}`);
    }
    const services = replyArray(reply, 'services');
    if (asJSON) {
        printLine(stableStringify(services));
        return;
    }
    // Ages against the daemon's clock (when it scanned), not this machine's: over the TCP route
    // the two can differ.
    const scannedAt = Date.parse(asString(reply['scanned_at']) ?? '');
    printServicesTable(services, noHeader, homeDirectory(), Number.isFinite(scannedAt) ? scannedAt : Date.now());
}

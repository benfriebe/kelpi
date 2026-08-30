/**
 * `kelpi doctor [--json]` (cli.md §16) — eight checks, in order, with concrete repair tips.
 * (`routing` is the eighth: where agent events actually go, on a machine that may be
 * running the Swift app on the same default socket — see `doctor/checks.ts` routingCheck.)
 *
 * Exit code: 1 when any check FAILed, 0 otherwise (WARN is advisory), and **2** for an
 * unexpected argument — the only place in the CLI that uses exit 2.
 */

import dns from 'node:dns';

import { popSwitch } from '../args.js';
import { env, homeDirectory } from '../env.js';
import { errLine, exit, printLine } from '../io.js';
import { stableStringify } from '../json.js';
import { runProcess } from '../proc.js';
import { currentTransport, sendJSONAndReadReply } from '../transport.js';
import { resolveCliIdentity } from '../version.js';
import {
    nodeDoctorDeps,
    pingCheck,
    processCheck,
    reachabilityCheck,
    routingCheck,
    transportCheck,
    versionCheck,
    type PingFacts
} from '../doctor/checks.js';
import { claudeHooksCheck, codexHooksCheck } from '../doctor/hooks.js';
import { exitCodeFor, printHumanReport, reportJSON, type DoctorCheck } from '../doctor/types.js';

async function resolveHost(host: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        dns.lookup(host, { family: 4 }, (error) => {
            resolve(error === null);
        });
    });
}

export async function handleDoctor(args: string[]): Promise<void> {
    const asJSON = popSwitch('--json', args);
    const extra = args[0];
    if (extra !== undefined) {
        errLine(`kelpi doctor: unexpected argument: ${extra}`);
        errLine('Usage: kelpi doctor [--json]');
        exit(2);
    }

    const transport = currentTransport();
    const checks: DoctorCheck[] = [];
    const facts: PingFacts = {};

    checks.push(transportCheck(transport, env()['KELPI_SOCKET'] !== undefined || env()['NEX_SOCKET'] !== undefined));
    checks.push(
        await reachabilityCheck(transport, {
            socketExists: nodeDoctorDeps.socketExists,
            resolveHost
        })
    );
    // 2-second window: fast enough that a wedged peer fails promptly.
    const ping = await sendJSONAndReadReply({ command: 'ping' }, { timeoutSeconds: 2 });
    checks.push(pingCheck(ping, facts));
    checks.push(routingCheck(facts));
    checks.push(
        await processCheck(
            transport,
            {
                env: env(),
                platform: nodeDoctorDeps.platform,
                home: homeDirectory(),
                run: runProcess,
                readFile: nodeDoctorDeps.readFile,
                isAlive: nodeDoctorDeps.isAlive
            },
            facts
        )
    );
    checks.push(versionCheck(resolveCliIdentity(env()), facts));
    const hookFs = { readFile: nodeDoctorDeps.readFile, isDirectory: nodeDoctorDeps.isDirectory };
    checks.push(claudeHooksCheck(hookFs, homeDirectory()));
    checks.push(codexHooksCheck(hookFs, homeDirectory()));

    if (asJSON) printLine(stableStringify(reportJSON(checks)));
    else printHumanReport(checks);
    exit(exitCodeFor(checks));
}

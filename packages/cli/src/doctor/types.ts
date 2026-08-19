/**
 * Doctor's data model (cli.md §16): a list of `{name, status, detail, repair?}` records, an
 * exit code that is non-zero ONLY when something FAILed, and two renderings.
 *
 * WARN never changes the exit code on purpose: scripts gate on transport/app health, not on
 * advisory drift like hook config or a CLI/daemon version mismatch.
 */

import { printLine } from '../io.js';
import type { JsonObject, JsonValue } from '../json.js';

export type DoctorStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

export interface DoctorCheck {
    readonly name: string;
    readonly status: DoctorStatus;
    readonly detail: string;
    readonly repair?: string | undefined;
}

export function exitCodeFor(checks: readonly DoctorCheck[]): number {
    return checks.some((check) => check.status === 'FAIL') ? 1 : 0;
}

export function printHumanReport(checks: readonly DoctorCheck[]): void {
    for (const check of checks) {
        printLine(`[${check.status}] ${check.name}: ${check.detail}`);
        if (check.repair !== undefined && check.status !== 'PASS') printLine(`        → ${check.repair}`);
    }
    const fails = checks.filter((check) => check.status === 'FAIL').length;
    const warns = checks.filter((check) => check.status === 'WARN').length;
    printLine('');
    if (fails === 0 && warns === 0) printLine('All checks passed.');
    else printLine(`Summary: ${String(fails)} fail(s), ${String(warns)} warn(s).`);
}

export function reportJSON(checks: readonly DoctorCheck[]): JsonObject {
    return {
        ok: exitCodeFor(checks) === 0,
        checks: checks.map((check) => {
            const entry: JsonObject = {
                name: check.name,
                status: check.status.toLowerCase(),
                detail: check.detail
            };
            if (check.repair !== undefined) entry['repair'] = check.repair;
            return entry;
        }) as unknown as JsonValue
    };
}

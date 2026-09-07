/**
 * The battery runner: run every component, retry once in isolation what failed, then decide.
 *
 * WHY THIS EXISTS. `verify.mjs`'s old `run` helper called `process.exit` on the first nonzero
 * status, so one flaky check cost a 20-minute battery and, because `self-upgrade.mjs` gates a
 * promote on `verify.mjs --full`, the release with it. Four promote attempts died that way on
 * 2026-09-07 and 2026-09-08, each on a single wobble that passed in isolation minutes later:
 * `dock-bounce-stop-only` (a scenario whose occlusion precondition the environment could not
 * meet, #109), `stuck-drag-teardown` (a mid-gesture cursor read), `App.filemenu.test.tsx` (load
 * average 37) and two daemon tests (load average 90). The identical product tree had already
 * passed two hand-run full batteries, so every one of those four was the battery's weather and
 * not the tree.
 *
 * THE TWO RULES, and why each is safe.
 *
 * 1. RUN EVERYTHING, DECIDE AT THE END. Exiting early hides every other failure behind the
 *    first one, so a red battery told you about one problem per 20 minutes. Running the rest
 *    costs the time the run was always going to take when it was green, and buys the whole
 *    picture. The one exception is a component marked `precondition`: `build bundles` is not a
 *    check, it is what the scenario lane, the audit and the smoke DRIVE. Continuing past a
 *    failed build would run three components against a stale or absent `dist/` and report
 *    failures that say nothing about the tree, so the components after it are marked "not run".
 *
 * 2. RETRY ONCE, IN ISOLATION, ONLY WHAT FAILED. A retry is not a second chance for the same
 *    conditions: the failed test FILES (parsed from vitest's JSON report, never scraped from
 *    the terminal's colours) or the failed SCENARIOS (read from the lane's `results.json`) are
 *    re-run on their own, off the load the rest of the battery was making. That is exactly the
 *    isolation a person performs by hand after a red battery, and it is what every one of the
 *    four dead promotes was fixed by. A component that fails its retry fails the battery, and
 *    the summary names the check that was red both times, so this can never launder a real
 *    regression into a pass: a deterministic failure fails alone too.
 *
 * The runner is pure with respect to the world: `components` supply their own `run`, so
 * `battery.test.mjs` drives the whole decision with a fake component runner and no daemon.
 */

/** A component's four possible ends. `retried` in the record says how a "passed" was reached. */
export const PASSED = 'passed';
export const PASSED_ON_RETRY = 'passed on retry';
/** Red, with nothing that could be isolated (a crash, a config error, a killed worker). */
export const FAILED = 'failed';
/** Red on the first run and red again alone: a real failure, not a wobble. */
export const FAILED_TWICE = 'failed twice';
/** A precondition ahead of it failed, so running it would have measured nothing. */
export const NOT_RUN = 'not run';

const GREEN = new Set([PASSED, PASSED_ON_RETRY]);

/**
 * Run the components in order and return every result.
 *
 * A component is `{ label, precondition?, run }`, where `run()` returns:
 *   `{ ok: true }`                                     green, nothing more to do
 *   `{ ok: false, detail }`                            red, and nothing can be isolated
 *   `{ ok: false, retryOf: [...], retry: () => ... }`  red, and this is what to re-run alone
 * `retry()` returns `{ ok, detail }` and is called at most once, by design: a check that needs
 * three goes to come out green is not flaky, it is broken, and the battery should say so.
 */
export async function runBattery({ components, log = () => {}, now = () => Date.now() }) {
    const records = [];
    for (const [index, component] of components.entries()) {
        const started = now();
        log(`▶ ${component.label}`);
        const outcome = (await component.run()) ?? {};
        const record = {
            label: component.label,
            state: outcome.ok === true ? PASSED : FAILED,
            retried: false,
            retryOf: null,
            detail: outcome.detail ?? null,
            ms: now() - started
        };

        if (record.state === FAILED && typeof outcome.retry === 'function') {
            record.retried = true;
            record.retryOf = outcome.retryOf ?? [];
            log(`  ✗ ${component.label} failed. Retrying once, in isolation: ${record.retryOf.join(', ') || 'the whole component'}`);
            const again = (await outcome.retry()) ?? {};
            record.state = again.ok === true ? PASSED_ON_RETRY : FAILED_TWICE;
            if (again.detail !== undefined) record.detail = again.detail;
            record.ms = now() - started;
        }

        records.push(record);
        if (GREEN.has(record.state)) {
            log(`✓ ${component.label}${record.state === PASSED_ON_RETRY ? ' (red under the battery, green alone: the retry saved this run)' : ''}`);
            continue;
        }

        log(`✗ ${component.label} FAILED${record.state === FAILED_TWICE ? ' TWICE (first under the battery, then alone)' : ''}`);
        if (component.precondition === true) {
            for (const rest of components.slice(index + 1)) {
                records.push({
                    label: rest.label,
                    state: NOT_RUN,
                    retried: false,
                    retryOf: null,
                    detail: `${component.label} is a precondition and it failed, so this would have measured a stale tree`,
                    ms: 0
                });
            }
            break;
        }
    }

    const failed = records.filter((record) => !GREEN.has(record.state));
    return { ok: failed.length === 0, records, failed };
}

/**
 * The test FILES a vitest run failed on, from its `--reporter=json` report.
 *
 * Parsed, never scraped: a reporter's colours and its "❯ file" lines are output formatting and
 * change with the version, while `testResults[].name` is the absolute path of a file and
 * `status` is one of vitest's own words. An empty array means the run failed without naming a
 * failing file (an unhandled error at import time, a config error, an OOM-killed worker), and
 * the caller must NOT treat that as "nothing to retry, so it passed": there is simply nothing
 * that an isolated re-run could tell us, so the component fails.
 */
export function failedTestFilesFromVitestJson(report) {
    const results = Array.isArray(report?.testResults) ? report.testResults : [];
    const files = results.filter((entry) => entry?.status === 'failed').map((entry) => entry?.name);
    return [...new Set(files.filter((name) => typeof name === 'string' && name.length > 0))];
}

/**
 * The SCENARIOS a lane run failed on, from the `results.json` `scenario.mjs` writes.
 *
 * A scenario's verdict is `summary.failed`, the count of `rec.check`s that came back false, so
 * that is what this reads. It also accepts a bare array of summaries, which is what the tests
 * pass and what a future `--out`-less caller would have to assemble by hand.
 */
export function failedScenariosFromResults(results) {
    const summaries = Array.isArray(results) ? results : Array.isArray(results?.summaries) ? results.summaries : [];
    return summaries
        .filter((summary) => Number(summary?.failed ?? 0) > 0)
        .map((summary) => summary?.name)
        .filter((name) => typeof name === 'string' && name.length > 0);
}

const wall = (ms) => (ms >= 90_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`);

/**
 * The end-of-run table: component, result, wall time, retried or not. Every red row carries a
 * continuation line naming the exact check, because "the battery failed" is not actionable and
 * a 20-minute scrollback is not a place to go looking for the reason.
 */
export function formatBatterySummary(records) {
    const labels = Math.max('component'.length, ...records.map((record) => record.label.length));
    const states = Math.max('result'.length, ...records.map((record) => record.state.length));
    const lines = [`${'component'.padEnd(labels)}  ${'result'.padEnd(states)}  ${'wall'.padStart(6)}  retried`];
    lines.push('─'.repeat(labels + states + 6 + 7 + 6));
    for (const record of records) {
        lines.push(
            `${record.label.padEnd(labels)}  ${record.state.padEnd(states)}  ${wall(record.ms).padStart(6)}  ${record.retried ? 'yes' : 'no'}`
        );
        if (record.retried && (record.retryOf?.length ?? 0) > 0) {
            lines.push(`    retried alone: ${record.retryOf.join(', ')}`);
        }
        // Only a red row explains itself, so a green table stays a table. The detail is the
        // retry's own verdict when there was one, which is narrower than what was retried: it
        // names the check that was red BOTH times.
        if (record.detail !== null && record.detail !== undefined && !GREEN.has(record.state)) {
            lines.push(`    ${record.detail}`);
        }
    }
    return lines;
}

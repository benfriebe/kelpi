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
 *    The one failure that shape CAN launder is a scenario that is red only because of what ran
 *    before it, which passes alone every time: the retry history below tells those apart across
 *    batteries rather than within one (#215).
 *
 * The runner is pure with respect to the world: `components` supply their own `run`, so
 * `battery.test.mjs` drives the whole decision with a fake component runner and no daemon.
 */

import fs from 'node:fs';
import path from 'node:path';

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

// ── the retry history: what one isolated retry is not allowed to launder ────────────

/**
 * WHY THIS EXISTS (#215, spun out of #205). Rule 2 passes a component whose isolated retry came
 * back green, and for a genuinely load-sensitive check that is the right call. For a scenario
 * that fails whenever it runs after one particular predecessor and passes alone, it is the wrong
 * call every single time, and it is wrong quietly: three deterministic ordering failures were
 * filed as load-sensitive and laundered into passes for a fortnight that way.
 *
 * ONE battery cannot tell the two apart, because a wobble and an ordering failure look identical
 * in a single run. A HISTORY can: the lane order is the same every time, so an ordering failure
 * recurs on the same scenario in consecutive lanes, and a wobble does not. So the full lane's
 * per-scenario outcomes are kept across batteries, and a scenario that has failed N consecutive
 * full lanes and passed every isolated retry is printed as ordering-dependent, named with the
 * scenario that ran immediately before it and, when the runner's leak post-condition blamed one,
 * with the scenario it says left the state behind (`scripts/scenario.mjs` ▸ `leaksAgainst`).
 *
 * `runBattery` stays pure with respect to the world: the store is the two functions at the end of
 * this section, and everything that decides anything takes the history as an argument.
 */
export const LOAD_SENSITIVE = 'load-sensitive';
export const ORDERING_DEPENDENT = 'ordering-dependent';
/** N. Two is the smallest number that is not one run's weather, and it is what #205 needed. */
export const CONSECUTIVE_LANE_FAILS = 2;
/** Enough runs to see a streak and to see it end; a history is a signal, not an archive. */
const HISTORY_KEPT = 12;

/**
 * One reading per scenario of a FULL lane: did it fail under the lane, did its isolated retry
 * pass, what ran immediately before it, and who the leak post-condition blames for the state it
 * started from. Green scenarios are recorded too, because a green lane is what ends a streak.
 *
 * `stillRed` is the scenarios the isolated retry could not save, which is what the retry already
 * collects to explain itself.
 */
export function scenarioObservations(results, { stillRed = [] } = {}) {
    const summaries = Array.isArray(results) ? results : Array.isArray(results?.summaries) ? results.summaries : [];
    const leakers = new Set((Array.isArray(results?.leaks) ? results.leaks : []).map((entry) => entry?.name));
    const observations = [];
    let previous = null;
    let leakedBy = null;
    for (const summary of summaries) {
        const name = summary?.name;
        if (typeof name !== 'string' || name.length === 0) continue;
        const failedLane = Number(summary?.failed ?? 0) > 0;
        observations.push({
            name,
            failedLane,
            // `null`, not `false`, for a scenario that was never retried: "the retry was red" and
            // "there was no retry" are different facts and the streak rule reads both.
            retryPassed: failedLane ? !stillRed.includes(name) : null,
            predecessor: previous,
            // The nearest EARLIER scenario the leak report names, which is the one whose leavings
            // this scenario started from. The report attributes a leak once, to whoever made it.
            leakedBy
        });
        previous = name;
        if (leakers.has(name)) leakedBy = name;
    }
    return observations;
}

/**
 * This lane's observations folded into the stored history, as a new history.
 *
 * Each entry carries the fold that wrote it, which is what lets a KEY be dropped as well as an
 * entry. Only a green observation clears a scenario's streak, and only a lane that still contains
 * the scenario can write one, so without pruning a renamed or deleted scenario would keep its
 * verdict forever: the loudest line in the run, about something nobody can act on, clearable only
 * by deleting a gitignored file by hand.
 */
export function recordRetryHistory(history, observations, { at = new Date().toISOString() } = {}) {
    const fold = (Number.isInteger(history?.folds) && history.folds >= 0 ? history.folds : 0) + 1;
    const scenarios = {};
    for (const [name, entries] of Object.entries(history?.scenarios ?? {})) {
        const runs = Array.isArray(entries) ? entries : [];
        // A store written before folds were stamped reads as fold 0, so it survives its first
        // HISTORY_KEPT folds and is then either re-stamped by a lane that still runs it or dropped.
        const seenAt = Number.isInteger(runs.at(-1)?.fold) ? runs.at(-1).fold : 0;
        if (fold - seenAt < HISTORY_KEPT) scenarios[name] = runs;
    }
    for (const { name, ...observation } of observations) {
        const past = Array.isArray(scenarios[name]) ? scenarios[name] : [];
        scenarios[name] = [...past, { at, fold, ...observation }].slice(-HISTORY_KEPT);
    }
    return { version: 1, folds: fold, scenarios };
}

/**
 * What to call each scenario THIS battery saved with an isolated retry. A scenario is
 * ordering-dependent once its trailing run of consecutive full-lane failures reaches `consecutive`
 * and every one of them was rescued by the retry; anything shorter is still load-sensitive, which
 * is what a real wobble looks like. Nothing else gets a verdict: a scenario that passed the lane
 * needs no word, and one whose retry was red is already failing the battery under its own name.
 *
 * A red retry INSIDE the streak resets the claim rather than strengthening it, on purpose. This
 * line exists to say what an isolated retry is hiding, and a lane whose retry was also red hid
 * nothing: it failed the battery under the scenario's own name, with `red alone as well` in the
 * table, so a person has already seen that failure whole.
 *
 * `consecutive` is validated here rather than trusted, because it reaches this function from an
 * env var two files away. An exported-but-empty variable is an ordinary shell accident, and a
 * `consecutive` of 0 would call every rescued failure ordering-dependent on its first lane, which
 * is #205's mislabel pointed the other way; a typo would turn the rule off with no message at all.
 */
export function retryVerdicts(history, { consecutive = CONSECUTIVE_LANE_FAILS } = {}) {
    const wanted = Number.isFinite(consecutive) && consecutive >= 1 ? Math.ceil(consecutive) : CONSECUTIVE_LANE_FAILS;
    const verdicts = [];
    for (const [name, entries] of Object.entries(history?.scenarios ?? {})) {
        const runs = Array.isArray(entries) ? entries : [];
        const last = runs.at(-1);
        if (last?.failedLane !== true || last?.retryPassed !== true) continue;
        let lanes = 0;
        let everyRetryPassed = true;
        for (const run of [...runs].reverse()) {
            if (run?.failedLane !== true) break;
            lanes += 1;
            if (run?.retryPassed !== true) everyRetryPassed = false;
        }
        // Whether the streak ran behind the SAME scenario every time. Two failures behind two
        // different predecessors is evidence against a predecessor-specific ordering failure, and
        // the name is the actionable half of the line, so the streak still counts but the line
        // has to say the predecessor moved rather than assert a cause that held once.
        const streak = runs.slice(-lanes);
        const drifted = streak.find((run) => (run?.predecessor ?? null) !== (last.predecessor ?? null));
        verdicts.push({
            name,
            verdict: lanes >= wanted && everyRetryPassed ? ORDERING_DEPENDENT : LOAD_SENSITIVE,
            lanes,
            predecessor: last.predecessor ?? null,
            // Whether the predecessor MOVED is its own flag, not something to infer from the name:
            // `null` is a real predecessor ("it ran first in the lane"), so a scenario that GAINED
            // one mid-streak read as "no drift" and the note went silent in exactly that direction.
            predecessorDrifted: drifted !== undefined,
            predecessorThen: drifted === undefined ? null : drifted.predecessor ?? null,
            leakedBy: last.leakedBy ?? null
        });
    }
    return verdicts;
}

/** Nothing recorded yet: what an absent, unreadable or foreign store reads as. */
const emptyHistory = () => ({ version: 1, folds: 0, scenarios: {} });

/**
 * The store, or an empty history when the file is absent, unreadable or not this shape.
 *
 * `version` is honoured rather than decorative: a store a later version wrote is a store this code
 * does not know how to fold, and starting again from empty costs N lanes of history where reading
 * it as v1 would mis-parse it silently. The shape is checked for the same reason, an ARRAY being
 * the one that passes a bare `typeof === 'object'`.
 */
export function readRetryHistory(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed?.version !== 1) return emptyHistory();
        if (typeof parsed.scenarios !== 'object' || parsed.scenarios === null || Array.isArray(parsed.scenarios)) return emptyHistory();
        return {
            version: 1,
            folds: Number.isInteger(parsed.folds) && parsed.folds >= 0 ? parsed.folds : 0,
            scenarios: parsed.scenarios
        };
    } catch {
        return emptyHistory();
    }
}

/**
 * Evidence, never a gate: a history that will not write must not fail an otherwise green run.
 *
 * Written beside the store and renamed over it, because `writeFileSync` truncates before it writes
 * and a battery that read the file in that window would parse nothing, fold its own single lane
 * into an empty history and write THAT back, resetting every streak in the file without a word.
 * `rename(2)` is an atomic replace on the same filesystem, so a reader gets the whole old file or
 * the whole new one. The read-modify-write around it is still unlocked, and that is accepted: two
 * overlapping batteries cost one missed lane, which shortens a streak, not a reset that erases it.
 */
export function writeRetryHistory(file, history) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${String(process.pid)}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify(history, null, 2)}\n`);
        fs.renameSync(temporary, file);
    } catch {
        /* a directory that will not write is not this battery's verdict */
    }
}

/**
 * The one line a retried scenario earns under the table. "load-sensitive" is a claim about this
 * machine's weather; "ordering-dependent" is a claim about the lane, so it has to name the lane
 * position that makes it: what ran immediately before, and whoever the leak post-condition
 * blamed for the state this scenario inherited.
 */
const verdictLine = (verdict) => {
    // A streak can only be counted as far back as the store kept, so one that fills the window is
    // "at least": the run before the oldest entry may well have been red too.
    const lanes = `${verdict.lanes >= HISTORY_KEPT ? 'at least ' : ''}${String(verdict.lanes)} full lane${verdict.lanes === 1 ? '' : 's'}`;
    if (verdict.verdict !== ORDERING_DEPENDENT) return `${verdict.name}: ${LOAD_SENSITIVE} (red in ${lanes}, green alone)`;
    const after = verdict.predecessor === null ? 'it runs first in the lane' : `it runs after ${verdict.predecessor}`;
    const drift =
        verdict.predecessorDrifted === true
            ? ` (it ran ${verdict.predecessorThen === null ? 'first in the lane' : `after ${verdict.predecessorThen}`} when the streak started)`
            : '';
    const leak = verdict.leakedBy === null ? '' : `; the lane's leak post-condition named ${verdict.leakedBy} as leaving state behind`;
    return `${verdict.name}: ${ORDERING_DEPENDENT} (red in ${lanes} in a row, green in every isolated retry), ${after}${drift}${leak}`;
};

const wall = (ms) => (ms >= 90_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`);

/**
 * The end-of-run table: component, result, wall time, retried or not. Every red row carries a
 * continuation line naming the exact check, because "the battery failed" is not actionable and
 * a 20-minute scrollback is not a place to go looking for the reason.
 *
 * `verdicts` is `retryVerdicts(history)`, and it adds one line per retried scenario saying which
 * kind of green-alone this was. Empty by default, so a caller that keeps no history reads exactly
 * as it did before (#215).
 */
export function formatBatterySummary(records, verdicts = []) {
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
            // Only what this component actually retried: the vitest components retry FILES, which
            // no scenario history has a verdict for, so they print nothing extra.
            for (const name of record.retryOf) {
                const verdict = verdicts.find((entry) => entry.name === name);
                if (verdict !== undefined) lines.push(`    ${verdictLine(verdict)}`);
            }
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

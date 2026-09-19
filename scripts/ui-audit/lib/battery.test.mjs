/**
 * The battery runner's own tests.
 *
 * The runner decides whether a promote may proceed, and it is now allowed to turn a red run into
 * a green one, so being wrong about it is expensive in BOTH directions: a retry that swallowed a
 * real failure would ship a regression, and a retry that never fired would leave the four dead
 * promotes of 2026-09-07/08 exactly where they were. Every branch is driven here with a fake
 * component runner, so the whole decision is exercised without a daemon, a window or a suite.
 *
 * These run under the ROOT vitest through the `harness` project in `vitest.config.ts`, beside
 * `verify-plan.test.mjs`, for the reason that file's header gives.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    FAILED,
    FAILED_TWICE,
    LOAD_SENSITIVE,
    NOT_RUN,
    ORDERING_DEPENDENT,
    PASSED,
    PASSED_ON_RETRY,
    failedScenariosFromResults,
    failedTestFilesFromVitestJson,
    formatBatterySummary,
    readRetryHistory,
    recordRetryHistory,
    retryVerdicts,
    runBattery,
    scenarioObservations,
    writeRetryHistory
} from './battery.mjs';

/**
 * A fake component. `outcomes` is what its `run` returns on each call, in order; `calls` records
 * how often the runner reached for it, which is how "at most one retry" is pinned.
 */
const fake = (label, outcome, { precondition = false } = {}) => {
    const calls = { run: 0, retry: 0 };
    return {
        calls,
        component: {
            label,
            precondition,
            run: () => {
                calls.run += 1;
                if (outcome.ok === true) return { ok: true };
                if (outcome.retryOk === undefined) return { ok: false, detail: outcome.detail ?? null };
                return {
                    ok: false,
                    retryOf: outcome.retryOf ?? [`${label} check`],
                    retry: () => {
                        calls.retry += 1;
                        return outcome.retryOk === true ? { ok: true } : { ok: false, detail: `red alone as well: ${(outcome.retryOf ?? []).join(', ')}` };
                    }
                };
            }
        }
    };
};

const labels = (records) => records.map((record) => [record.label, record.state]);

describe('the battery runs every component and decides at the end', () => {
    it('passes when every component is green, in the order it was given', async () => {
        const parts = [fake('typecheck', { ok: true }), fake('root tests', { ok: true }), fake('full audit', { ok: true })];
        const battery = await runBattery({ components: parts.map((p) => p.component) });

        expect(battery.ok).toBe(true);
        expect(labels(battery.records)).toEqual([
            ['typecheck', PASSED],
            ['root tests', PASSED],
            ['full audit', PASSED]
        ]);
        expect(battery.records.every((record) => record.retried === false)).toBe(true);
        expect(battery.failed).toEqual([]);
    });

    it('runs the components AFTER a red one instead of exiting on the first failure', async () => {
        // The whole point of #109: a red battery used to report one problem per 20 minutes.
        const parts = [
            fake('root tests', { ok: false, retryOk: false, retryOf: ['App.filemenu.test.tsx'] }),
            fake('scenarios', { ok: true }),
            fake('packaged smoke', { ok: true })
        ];
        const battery = await runBattery({ components: parts.map((p) => p.component) });

        expect(battery.ok).toBe(false);
        expect(parts[1].calls.run).toBe(1);
        expect(parts[2].calls.run).toBe(1);
        expect(labels(battery.records)).toEqual([
            ['root tests', FAILED_TWICE],
            ['scenarios', PASSED],
            ['packaged smoke', PASSED]
        ]);
    });

    it('records a wall time per component', async () => {
        let clock = 0;
        const ticks = [0, 1000, 1000, 4500];
        const battery = await runBattery({
            components: [fake('typecheck', { ok: true }).component, fake('root tests', { ok: true }).component],
            now: () => ticks[clock++] ?? 0
        });
        expect(battery.records.map((record) => record.ms)).toEqual([1000, 3500]);
    });
});

describe('a first failure remains red when a diagnostic retry passes', () => {
    it('marks it retried and names what was re-run', async () => {
        const part = fake('root tests', { ok: false, retryOk: true, retryOf: ['packages/client/src/app/App.filemenu.test.tsx'] });
        const battery = await runBattery({ components: [part.component] });

        expect(battery.ok).toBe(false);
        expect(battery.records[0].state).toBe(PASSED_ON_RETRY);
        expect(battery.records[0].retried).toBe(true);
        expect(battery.records[0].retryOf).toEqual(['packages/client/src/app/App.filemenu.test.tsx']);
        expect(part.calls.retry).toBe(1);
    });

    it('retries ONCE and no more: a check that needs three goes is broken, not flaky', async () => {
        const part = fake('scenarios', { ok: false, retryOk: false, retryOf: ['dock-bounce-stop-only'] });
        await runBattery({ components: [part.component] });

        expect(part.calls.run).toBe(1);
        expect(part.calls.retry).toBe(1);
    });
});

describe('a component that fails its retry fails the battery, and the summary names the check', () => {
    it('reports it as red both times', async () => {
        const part = fake('scenarios', { ok: false, retryOk: false, retryOf: ['dock-bounce-stop-only', 'stuck-drag-teardown'] });
        const battery = await runBattery({ components: [part.component] });

        expect(battery.ok).toBe(false);
        expect(battery.records[0].state).toBe(FAILED_TWICE);
        expect(battery.failed.map((record) => record.label)).toEqual(['scenarios']);

        const table = formatBatterySummary(battery.records).join('\n');
        expect(table).toContain('failed twice');
        expect(table).toContain('retried alone: dock-bounce-stop-only, stuck-drag-teardown');
        expect(table).toContain('red alone as well: dock-bounce-stop-only, stuck-drag-teardown');
    });

    it('fails without a retry when nothing could be isolated', async () => {
        // A crash, a config error or a killed worker names no check, so there is nothing an
        // isolated re-run could tell us. It must never be excused for being unretryable.
        const part = fake('root tests', { ok: false, detail: 'exit 1 with no failed test file named' });
        const battery = await runBattery({ components: [part.component] });

        expect(battery.ok).toBe(false);
        expect(battery.records[0].state).toBe(FAILED);
        expect(battery.records[0].retried).toBe(false);
        expect(part.calls.retry).toBe(0);
        expect(formatBatterySummary(battery.records).join('\n')).toContain('exit 1 with no failed test file named');
    });

    it('stops at a failed PRECONDITION and marks the rest not run', async () => {
        // `build bundles` is not a check: the scenario lane, the audit and the smoke drive what it
        // produces, so running them past a red build would report a stale tree, not this one.
        const parts = [
            fake('build bundles', { ok: false, detail: 'esbuild: no such file' }, { precondition: true }),
            fake('scenarios', { ok: true }),
            fake('full audit', { ok: true })
        ];
        const battery = await runBattery({ components: parts.map((p) => p.component) });

        expect(battery.ok).toBe(false);
        expect(parts[1].calls.run).toBe(0);
        expect(parts[2].calls.run).toBe(0);
        expect(labels(battery.records)).toEqual([
            ['build bundles', FAILED],
            ['scenarios', NOT_RUN],
            ['full audit', NOT_RUN]
        ]);
    });
});

describe('the failed test files come out of vitest JSON, never out of the terminal', () => {
    const report = {
        success: false,
        testResults: [
            { name: '/repo/packages/core/src/a.test.ts', status: 'passed' },
            { name: '/repo/packages/daemon/src/b.test.ts', status: 'failed' },
            { name: '/repo/packages/client/src/app/App.filemenu.test.tsx', status: 'failed' }
        ]
    };

    it('returns exactly the files whose status is failed', () => {
        expect(failedTestFilesFromVitestJson(report)).toEqual([
            '/repo/packages/daemon/src/b.test.ts',
            '/repo/packages/client/src/app/App.filemenu.test.tsx'
        ]);
    });

    it('returns nothing for a green run, a missing report or a report with no test results', () => {
        expect(failedTestFilesFromVitestJson({ success: true, testResults: [{ name: '/repo/a.test.ts', status: 'passed' }] })).toEqual([]);
        expect(failedTestFilesFromVitestJson(null)).toEqual([]);
        expect(failedTestFilesFromVitestJson(undefined)).toEqual([]);
        // A run that died before any file ran is `success: false` with nothing named: the caller
        // must read "nothing to retry", which is not the same as "nothing failed".
        expect(failedTestFilesFromVitestJson({ success: false, testResults: [] })).toEqual([]);
    });

    it('deduplicates and ignores entries with no usable name', () => {
        expect(
            failedTestFilesFromVitestJson({
                testResults: [
                    { name: '/repo/a.test.ts', status: 'failed' },
                    { name: '/repo/a.test.ts', status: 'failed' },
                    { status: 'failed' },
                    { name: '', status: 'failed' }
                ]
            })
        ).toEqual(['/repo/a.test.ts']);
    });
});

describe('the failed scenarios come out of the lane results.json', () => {
    const results = {
        stamp: '2026-09-08T08-00-00-000Z',
        windowPlacement: 'hidden',
        summaries: [
            { name: 'confirm-dialog-keys', checks: 12, failed: 0 },
            { name: 'dock-bounce-stop-only', checks: 7, failed: 2 },
            { name: 'stuck-drag-teardown', checks: 9, failed: 1 }
        ]
    };

    it('returns the scenarios with at least one failed check', () => {
        expect(failedScenariosFromResults(results)).toEqual(['dock-bounce-stop-only', 'stuck-drag-teardown']);
    });

    it('accepts a bare array of summaries as well as the file shape', () => {
        expect(failedScenariosFromResults(results.summaries)).toEqual(['dock-bounce-stop-only', 'stuck-drag-teardown']);
    });

    it('returns nothing for a green lane or a results file that never got written', () => {
        expect(failedScenariosFromResults({ summaries: [{ name: 'confirm-dialog-keys', failed: 0 }] })).toEqual([]);
        expect(failedScenariosFromResults(null)).toEqual([]);
        expect(failedScenariosFromResults({})).toEqual([]);
    });
});

describe('the summary table', () => {
    it('carries every component, its result, its wall time and whether it was retried', async () => {
        let clock = 0;
        // Two `now()` calls per component, three for one that retries (start, first verdict,
        // retry verdict): typecheck 30 s, root tests 4.5 min including its retry, audit 30 s.
        const ticks = [0, 30_000, 30_000, 200_000, 300_000, 300_000, 330_000];
        const battery = await runBattery({
            components: [
                fake('typecheck', { ok: true }).component,
                fake('root tests', { ok: false, retryOk: true, retryOf: ['packages/daemon/src/b.test.ts'] }).component,
                fake('full audit', { ok: true }).component
            ],
            now: () => ticks[clock++] ?? 0
        });
        const table = formatBatterySummary(battery.records);

        expect(table[0]).toContain('component');
        expect(table[0]).toContain('result');
        expect(table[0]).toContain('wall');
        expect(table[0]).toContain('retried');
        const text = table.join('\n');
        expect(text).toContain('typecheck');
        expect(text).toContain('30.0s');
        expect(text).toContain('4.5m');
        expect(text).toContain('failed first attempt; retry passed');
        expect(text).toContain('retried alone: packages/daemon/src/b.test.ts');
        // A green component never explains itself: the table stays readable when nothing is wrong.
        expect(text).not.toContain('red alone as well');
    });
});

describe('the retry history tells an ordering failure from a wobble, across batteries (#215)', () => {
    /** One full lane's `results.json`: `[name, failedChecks]` in run order, plus who leaked. */
    const lane = (rows, leakedBy = []) => ({
        stamp: '2026-09-16T08-00-00-000Z',
        windowPlacement: 'hidden',
        summaries: rows.map(([name, failed]) => ({ name, checks: 11, failed, ms: 9000 })),
        leaks: leakedBy.map((name) => ({ name, leaked: ["the phone's remembered place is still set"] }))
    });

    /** The lane that #205 lived in: a producer that leaks, and the scenario that runs into it. */
    const laneThatLeaks = lane(
        [
            ['confirm-dialog-keys', 0],
            ['plugin-browser-features', 0],
            ['plugin-document-features', 3]
        ],
        ['plugin-browser-features']
    );

    const afterBatteries = (count, { stillRed = [] } = {}) => {
        let history = { version: 1, scenarios: {} };
        for (let index = 0; index < count; index += 1) {
            history = recordRetryHistory(history, scenarioObservations(laneThatLeaks, { stillRed }), {
                at: `2026-09-1${String(index + 1)}T08:00:00.000Z`
            });
        }
        return history;
    };

    /** The component the battery actually ran: red lane, green isolated retry of that scenario. */
    const retriedLane = async () =>
        runBattery({
            components: [fake('scenarios (all, hidden)', { ok: false, retryOk: true, retryOf: ['plugin-document-features'] }).component]
        });

    it('reads each scenario of the lane with what ran before it and who the leak report blames', () => {
        expect(scenarioObservations(laneThatLeaks)).toEqual([
            { name: 'confirm-dialog-keys', failedLane: false, retryPassed: null, predecessor: null, leakedBy: null },
            { name: 'plugin-browser-features', failedLane: false, retryPassed: null, predecessor: 'confirm-dialog-keys', leakedBy: null },
            {
                name: 'plugin-document-features',
                failedLane: true,
                retryPassed: true,
                predecessor: 'plugin-browser-features',
                leakedBy: 'plugin-browser-features'
            }
        ]);
        // The retry could not save it, so it is not a green-alone at all and gets no verdict later.
        expect(scenarioObservations(laneThatLeaks, { stillRed: ['plugin-document-features'] })[2].retryPassed).toBe(false);
    });

    it('calls a scenario that failed ONE lane and passed alone load-sensitive, as before', async () => {
        const verdicts = retryVerdicts(afterBatteries(1));
        expect(verdicts).toEqual([
            {
                name: 'plugin-document-features',
                verdict: LOAD_SENSITIVE,
                lanes: 1,
                predecessor: 'plugin-browser-features',
                // One lane cannot have drifted, so the predecessor of record is the only one there is.
                predecessorDrifted: false,
                predecessorThen: null,
                leakedBy: 'plugin-browser-features'
            }
        ]);

        const table = formatBatterySummary((await retriedLane()).records, verdicts).join('\n');
        expect(table).toContain('plugin-document-features: load-sensitive (red in 1 full lane, green alone)');
        expect(table).not.toContain(ORDERING_DEPENDENT);
    });

    it('calls it ordering-dependent after two consecutive lanes, and names the scenario before it', async () => {
        const verdicts = retryVerdicts(afterBatteries(2));
        expect(verdicts.map((verdict) => [verdict.name, verdict.verdict, verdict.lanes])).toEqual([
            ['plugin-document-features', ORDERING_DEPENDENT, 2]
        ]);

        const table = formatBatterySummary((await retriedLane()).records, verdicts).join('\n');
        expect(table).toContain('plugin-document-features: ordering-dependent (red in 2 full lanes in a row, green in every isolated retry)');
        expect(table).toContain('it runs after plugin-browser-features');
        // The runner's leak post-condition already named the predecessor; the battery says so on
        // the same line, because that name is the whole difference between a flake and a cause.
        expect(table).toContain("the lane's leak post-condition named plugin-browser-features as leaving state behind");
        expect(table).not.toContain(LOAD_SENSITIVE);
    });

    it('takes N from the caller: three lanes deep is still load-sensitive when N is four', () => {
        expect(retryVerdicts(afterBatteries(3), { consecutive: 4 })[0].verdict).toBe(LOAD_SENSITIVE);
        expect(retryVerdicts(afterBatteries(3), { consecutive: 3 })[0].verdict).toBe(ORDERING_DEPENDENT);
    });

    it('says nothing about a scenario whose retry was red, or one the lane never failed', () => {
        // Red twice is the battery's own failure under its own name, not a history question.
        expect(retryVerdicts(afterBatteries(2, { stillRed: ['plugin-document-features'] }))).toEqual([]);
        // A green lane ends the streak: the next fail starts again at one.
        const green = recordRetryHistory(afterBatteries(2), scenarioObservations(lane([['plugin-browser-features', 0], ['plugin-document-features', 0]])), {
            at: '2026-09-13T08:00:00.000Z'
        });
        expect(retryVerdicts(green)).toEqual([]);
        const again = recordRetryHistory(green, scenarioObservations(laneThatLeaks), { at: '2026-09-14T08:00:00.000Z' });
        expect(retryVerdicts(again)[0]).toMatchObject({ verdict: LOAD_SENSITIVE, lanes: 1 });
    });

    it('survives a round trip through the store, and reads an absent store as no history', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'battery-history-'));
        const file = path.join(dir, 'nested', 'battery-retry-history.json');
        try {
            // Nothing recorded yet: a first battery must read an empty history, not crash on one.
            expect(readRetryHistory(file)).toEqual({ version: 1, folds: 0, scenarios: {} });
            expect(retryVerdicts(readRetryHistory(file))).toEqual([]);

            writeRetryHistory(file, afterBatteries(1));
            // The second battery is a different process: it can only see what the file kept.
            const reloaded = recordRetryHistory(readRetryHistory(file), scenarioObservations(laneThatLeaks), { at: '2026-09-15T08:00:00.000Z' });
            writeRetryHistory(file, reloaded);

            expect(readRetryHistory(file)).toEqual(reloaded);
            expect(readRetryHistory(file).scenarios['plugin-document-features']).toHaveLength(2);
            expect(retryVerdicts(readRetryHistory(file))[0]).toMatchObject({
                verdict: ORDERING_DEPENDENT,
                lanes: 2,
                predecessor: 'plugin-browser-features'
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('keeps the last twelve folds per scenario, drops the oldest, and says "at least" when it is full', async () => {
        let history = { version: 1, folds: 0, scenarios: {} };
        for (let fold = 1; fold <= 13; fold += 1) {
            history = recordRetryHistory(history, scenarioObservations(laneThatLeaks), { at: `fold-${String(fold)}` });
        }
        const runs = history.scenarios['plugin-document-features'];
        // The cap is per scenario and it drops from the FRONT: thirteen folds leave folds 2 to 13.
        expect(runs).toHaveLength(12);
        expect(runs.at(0).at).toBe('fold-2');
        expect(runs.at(-1).at).toBe('fold-13');

        // A streak that fills the window cannot be counted past it, and the line must not pretend
        // otherwise: the run before the oldest entry kept may well have been red too.
        const verdicts = retryVerdicts(history);
        expect(verdicts[0]).toMatchObject({ verdict: ORDERING_DEPENDENT, lanes: 12 });
        const table = formatBatterySummary((await retriedLane()).records, verdicts).join('\n');
        expect(table).toContain('red in at least 12 full lanes in a row');
    });

    it('resets the claim when one retry inside the streak was red, and says so as load-sensitive', () => {
        // Deliberate: that battery went red under the scenario's own name, so nothing was hidden by
        // a retry and this line has nothing to add. Four lanes deep, one red alone, still a wobble.
        let history = { version: 1, folds: 0, scenarios: {} };
        for (const stillRed of [[], ['plugin-document-features'], [], []]) {
            history = recordRetryHistory(history, scenarioObservations(laneThatLeaks, { stillRed }), { at: 'x' });
        }
        expect(retryVerdicts(history)).toMatchObject([{ name: 'plugin-document-features', verdict: LOAD_SENSITIVE, lanes: 4 }]);
    });

    it('validates N instead of trusting it: empty, zero, negative and unparsable all read as the default', () => {
        const one = afterBatteries(1);
        const two = afterBatteries(2);
        // `Number('')` and `Number('0')` are 0, which would make the FIRST rescued failure
        // ordering-dependent; `Number('abc')` is NaN, which would turn the rule off entirely.
        for (const bad of [0, -1, Number.NaN, Number(''), '2', null]) {
            expect(retryVerdicts(one, { consecutive: bad })[0].verdict).toBe(LOAD_SENSITIVE);
            expect(retryVerdicts(two, { consecutive: bad })[0].verdict).toBe(ORDERING_DEPENDENT);
        }
        // A fraction is rounded UP, so 2.5 means three: it must never be easier than the integer above it.
        expect(retryVerdicts(two, { consecutive: 2.5 })[0].verdict).toBe(LOAD_SENSITIVE);
        expect(retryVerdicts(afterBatteries(3), { consecutive: 2.5 })[0].verdict).toBe(ORDERING_DEPENDENT);
    });

    it('says the predecessor moved when the streak did not run behind the same scenario twice', async () => {
        const behind = (name) => lane([['confirm-dialog-keys', 0], [name, 0], ['plugin-document-features', 3]], [name]);
        let history = recordRetryHistory({ version: 1, folds: 0, scenarios: {} }, scenarioObservations(behind('plugin-browser-features')), { at: '1' });
        history = recordRetryHistory(history, scenarioObservations(behind('plugin-chrome-features')), { at: '2' });

        const verdicts = retryVerdicts(history);
        expect(verdicts[0]).toMatchObject({
            verdict: ORDERING_DEPENDENT,
            lanes: 2,
            predecessor: 'plugin-chrome-features',
            predecessorDrifted: true,
            predecessorThen: 'plugin-browser-features'
        });
        const table = formatBatterySummary((await retriedLane()).records, verdicts).join('\n');
        expect(table).toContain('it runs after plugin-chrome-features (it ran after plugin-browser-features when the streak started)');
    });

    it('says the predecessor moved in the other direction too: a scenario that GAINED one mid-streak', async () => {
        // `null` is a real predecessor ("it ran first in the lane"), so the drift cannot be inferred
        // from the name: inserting an alphabetically earlier scenario is exactly how this happens.
        const first = lane([['plugin-document-features', 3], ['confirm-dialog-keys', 0]]);
        const second = lane([['plugin-browser-features', 0], ['plugin-document-features', 3]], ['plugin-browser-features']);
        let history = recordRetryHistory({ version: 1, folds: 0, scenarios: {} }, scenarioObservations(first), { at: '1' });
        history = recordRetryHistory(history, scenarioObservations(second), { at: '2' });

        const verdicts = retryVerdicts(history);
        expect(verdicts[0]).toMatchObject({
            verdict: ORDERING_DEPENDENT,
            lanes: 2,
            predecessor: 'plugin-browser-features',
            predecessorDrifted: true,
            predecessorThen: null
        });
        const table = formatBatterySummary((await retriedLane()).records, verdicts).join('\n');
        expect(table).toContain('it runs after plugin-browser-features (it ran first in the lane when the streak started)');
    });

    it('forgets a scenario the lane has not run for twelve folds, so no verdict outlives its scenario', () => {
        const withGone = lane([['gone-away', 2], ['plugin-document-features', 3]], ['gone-away']);
        const withoutGone = lane([['plugin-document-features', 3]]);
        let history = recordRetryHistory({ version: 1, folds: 0, scenarios: {} }, scenarioObservations(withGone), { at: '1' });
        expect(retryVerdicts(history).map((verdict) => verdict.name)).toContain('gone-away');

        for (let fold = 0; fold < 11; fold += 1) history = recordRetryHistory(history, scenarioObservations(withoutGone), { at: 'n' });
        expect(Object.keys(history.scenarios)).toContain('gone-away');
        history = recordRetryHistory(history, scenarioObservations(withoutGone), { at: 'last' });
        expect(Object.keys(history.scenarios)).not.toContain('gone-away');
        expect(retryVerdicts(history).map((verdict) => verdict.name)).toEqual(['plugin-document-features']);
    });

    it('reads a truncated, foreign or wrong-shaped store as no history rather than throwing', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'battery-history-bad-'));
        const file = path.join(dir, 'battery-retry-history.json');
        try {
            // A store half-written by a battery that died: the one case the atomic rename exists to
            // prevent, and it must still read as nothing rather than take the run down.
            fs.writeFileSync(file, '{"version":1,"scen');
            expect(readRetryHistory(file)).toEqual({ version: 1, folds: 0, scenarios: {} });
            // A store a LATER version wrote is not one this code knows how to fold.
            fs.writeFileSync(file, JSON.stringify({ version: 2, scenarios: { target: [{ failedLane: true, retryPassed: true }] } }));
            expect(readRetryHistory(file).scenarios).toEqual({});
            // An array passes a bare `typeof === "object"`, so the shape is checked as well.
            fs.writeFileSync(file, JSON.stringify({ version: 1, scenarios: [] }));
            expect(readRetryHistory(file).scenarios).toEqual({});
            expect(retryVerdicts(readRetryHistory(file))).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

// Exceptions and empty plans must not disappear behind a report or green retry.
describe('strict evidence preservation', () => {
    it('retains both attempts and the original diagnostic', async () => {
        const battery = await runBattery({ components: [{ label: 'copy', run: () => ({ ok: false, detail: 'clipboard first failure', retry: () => ({ ok: true, detail: 'passes alone' }) }) }] });
        expect(battery.ok).toBe(false);
        expect(battery.records[0].firstAttempt.detail).toBe('clipboard first failure');
        expect(battery.records[0].retryAttempt.ok).toBe(true);
        expect(battery.records[0].detail).toContain('clipboard first failure');
    });
    it('continues after a thrown check and refuses an empty battery', async () => {
        const battery = await runBattery({ components: [{ label: 'throws', run: () => { throw new Error('broken report'); } }, { label: 'next', run: () => ({ ok: true }) }] });
        expect(battery.records).toHaveLength(2);
        expect(battery.ok).toBe(false);
        expect((await runBattery({ components: [] })).ok).toBe(false);
    });
});

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
import { describe, expect, it } from 'vitest';

import {
    FAILED,
    FAILED_TWICE,
    NOT_RUN,
    PASSED,
    PASSED_ON_RETRY,
    failedScenariosFromResults,
    failedTestFilesFromVitestJson,
    formatBatterySummary,
    runBattery
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

describe('a component that fails and comes back green alone passes, and says so', () => {
    it('marks it retried and names what was re-run', async () => {
        const part = fake('root tests', { ok: false, retryOk: true, retryOf: ['packages/client/src/app/App.filemenu.test.tsx'] });
        const battery = await runBattery({ components: [part.component] });

        expect(battery.ok).toBe(true);
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
        expect(text).toContain('passed on retry');
        expect(text).toContain('retried alone: packages/daemon/src/b.test.ts');
        // A green component never explains itself: the table stays readable when nothing is wrong.
        expect(text).not.toContain('red alone as well');
    });
});

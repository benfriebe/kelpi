/** Strict interpretation of raw runner records. Summary booleans are never authority. */
export const precedence = (values) => values.includes('failed') ? 'failed' : values.includes('unverified') || values.length === 0 ? 'unverified' : 'verified';
export const exitCode = (verdict) => verdict === 'verified' ? 0 : verdict === 'failed' ? 1 : 2;
const list = (value) => Array.isArray(value) ? value : [];
const named = (value) => typeof value === 'string' && value.trim().length > 0;

export function inspectResults(kind, report, { exitStatus = 0, runId, head, startedAt, finishedAt = Date.now(), requireProvenance = true, approvedVisuals = [] } = {}) {
    const failures = [], missing = [], assertions = [], visuals = [];
    const bad = (message) => failures.push(message);
    const absent = (message) => missing.push(message);
    if (exitStatus !== 0) bad(`process exit ${exitStatus}`);
    if (report?.harnessFailure) bad(`harness failure: ${JSON.stringify(report.harnessFailure)}`);
    if (!report || typeof report !== 'object' || Array.isArray(report)) absent('missing or malformed structured report');
    if (report && kind !== 'vitest' && requireProvenance) {
        const p = report.provenance ?? report.meta?.provenance;
        if (!p || p.runId !== runId || p.head !== head || (p.requestedHead != null && p.requestedHead !== p.head)) absent('report run/commit identity does not match');
        if (!Array.isArray(p?.dirtyFiles) || p.dirtyFiles.length) absent('runner source was dirty or not recorded');
        const reportStart = Date.parse(p?.startedAt ?? report.startedAt ?? report.meta?.startedAt);
        if (!Number.isFinite(reportStart) || reportStart < startedAt - 1000 || reportStart > finishedAt) absent('stale or absent report start time');
    }
    const check = (entry, prefix, vitest = false) => {
        const id = vitest ? entry?.fullName ?? entry?.title : kind === 'scenario' ? entry?.label : entry?.name;
        const status = vitest ? entry?.status : entry?.ok === true ? 'passed' : entry?.ok === false ? 'failed' : 'unknown';
        if (!named(id)) absent(`${prefix}: assertion has no name`);
        if (status === 'failed') bad(`${prefix}: ${id}`);
        else if (status !== 'passed') absent(`${prefix}: ${id ?? 'assertion'} ${status}`);
        assertions.push({ id: `${prefix} > ${id}`, name: id, status });
    };
    if (kind === 'vitest') {
        if (!Array.isArray(report?.testResults) || report.testResults.length === 0) absent('no test files executed');
        if (requireProvenance && (!Number.isFinite(report?.startTime) || report.startTime < startedAt - 1000 || report.startTime > finishedAt)) absent('stale or absent vitest start time');
        for (const file of list(report?.testResults)) {
            if (!named(file?.name) || !Array.isArray(file?.assertionResults)) absent('malformed test file');
            if (file?.status === 'failed' || file?.message) bad(`${file?.name}: test file error`);
            if (!['passed', 'failed'].includes(file?.status)) absent(`${file?.name}: incomplete test file`);
            for (const entry of list(file?.assertionResults)) check(entry, file.name, true);
        }
        const counts = { numTotalTests: assertions.length, numPassedTests: assertions.filter(a => a.status === 'passed').length, numFailedTests: assertions.filter(a => a.status === 'failed').length };
        for (const [key, count] of Object.entries(counts)) if (report?.[key] !== count) absent(`vitest ${key} counter mismatch`);
        if (Number(report?.numFailedTestSuites) > 0 || Number(report?.numRuntimeErrorTestSuites) > 0 || list(report?.unhandledErrors).length > 0) bad('vitest runtime/suite errors');
        if (report?.success === false) bad('vitest reported failure');
    } else if (kind === 'audit') {
        if (!Array.isArray(report?.steps) || report.steps.length === 0) absent('no audit steps executed');
        for (const step of list(report?.steps)) {
            if (!named(step?.id) || !Array.isArray(step?.assertions)) absent('malformed audit step');
            if (step?.error) bad(`${step.id}: step error: ${step.error}`);
            if (step?.needsEyes && !approvedVisuals.includes(step.id)) visuals.push(step.id);
            for (const entry of list(step?.assertions)) check(entry, step.id);
        }
        const counts = { total: list(report?.steps).length, assertions: assertions.length, failedAssertions: assertions.filter(a => a.status === 'failed').length, errored: list(report?.steps).filter(s => s?.error).length, eyes: list(report?.steps).filter(s => s?.needsEyes).length };
        for (const [key, count] of Object.entries(counts)) if (report?.summary?.[key] !== count) absent(`audit ${key} counter mismatch`);
    } else if (kind === 'scenario') {
        if (!Array.isArray(report?.summaries) || report.summaries.length === 0) absent('no scenarios executed');
        for (const summary of list(report?.summaries)) {
            const entries = summary?.results;
            if (!named(summary?.name) || !Array.isArray(entries)) absent('missing raw scenario assertions');
            for (const entry of list(entries)) check(entry, summary.name);
            const failed = list(entries).filter(a => a?.ok === false).length;
            if (summary?.checks !== list(entries).length || summary?.failed !== failed) absent(`${summary?.name}: scenario counter mismatch`);
            if (Number(summary?.failed) > 0 || summary?.error) bad(`${summary?.name}: scenario failed`);
            if (list(summary?.leaked).length > 0) bad(`${summary.name}: cleanup leak`);
        }
        if (list(report?.leaks).length > 0) bad('scenario cleanup leaks');
    } else absent(`unsupported structured report kind: ${kind}`);
    if (kind === 'audit' || kind === 'scenario') {
        const cleanup = report?.cleanup ?? report?.meta?.cleanup;
        if (!cleanup || cleanup.attempted !== true || cleanup.completed !== true || !Array.isArray(cleanup.errors) || !Array.isArray(cleanup.leaks)) absent('cleanup was not fully evidenced');
        if (list(cleanup?.errors).length > 0 || list(cleanup?.leaks).length > 0) bad('cleanup errors or unresolved leaks');
    }
    if (assertions.length === 0) absent('no named assertions executed');
    if (new Set(assertions.map(a => a.id)).size !== assertions.length) absent('duplicate assertion identities');
    if (visuals.length > 0) absent(`outstanding visual review: ${visuals.join(', ')}`);
    return { verdict: failures.length ? 'failed' : missing.length ? 'unverified' : 'verified', failures, missing, assertions, visuals, counts: { total: assertions.length, failed: assertions.filter(a => a.status === 'failed').length, stepErrors: kind === 'audit' ? list(report?.steps).filter(s => s?.error).length : 0, harnessErrors: report?.harnessFailure ? 1 : 0, cleanupErrors: list((report?.cleanup ?? report?.meta?.cleanup)?.errors).length, cleanupLeaks: list((report?.cleanup ?? report?.meta?.cleanup)?.leaks).length + list(report?.leaks).length } };
}

/** Strict, append-only structured evidence for shell smoke runners. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureProvenance, bindCoreExecution } from './incident-diagnostics-replay.mjs';
import { executionRoots } from './execution-roots.mjs';
import { smokePlan } from './smoke-plan.mjs';

const reportPath = argv => {
    const i = argv.indexOf('--acceptance-report');
    return i >= 0 ? argv[i + 1] : process.env.KELPI_ACCEPTANCE_SMOKE_REPORT;
};

export function installSmokeEvidence({ repoRoot, name, results, argv = process.argv.slice(2), source = process.argv[1] }) {
    const output = reportPath(argv);
    if (!output) return Object.assign(() => {}, { beforeExecution() {}, recordCleanup() {}, recordScreenshot() {} });
    if (!path.isAbsolute(output) || fs.existsSync(output)) throw new Error('acceptance smoke report must be a new absolute path');
    const { harnessRoot } = executionRoots({ targetRoot: repoRoot });
    const selection = smokePlan(harnessRoot, name);
    const startedAt = new Date().toISOString();
    let provenance = null, initialFailure = null, wrote = false;
    const cleanups = [], screenshots = [];
    try { provenance = captureProvenance(repoRoot, [source]); }
    catch (error) { initialFailure = { failureClass: 'harness', detail: String(error?.stack ?? error) }; }
    const beforeExecution = boundary => {
        if (initialFailure) throw new Error(initialFailure.detail);
        return bindCoreExecution(repoRoot, provenance, { boundary: `smoke:${name}:${boundary}`, runtime: { packaged: name === 'packaged' } });
    };
    const finish = (exitStatus = process.exitCode ?? 0, harnessFailure = null) => {
        if (wrote) return;
        wrote = true;
        let failure = initialFailure ?? harnessFailure;
        try { beforeExecution('final-report'); }
        catch (error) { failure ??= { failureClass: 'harness', detail: String(error?.stack ?? error) }; }
        const assertions = results.map((result, index) => ({ id: `${name}:${String(index + 1)}`, name: String(result.name), ok: result.skipped ? null : result.ok === true, detail: String(result.detail ?? '') }));
        const cleanup = { attempted: cleanups.length > 0 && cleanups.every(c => c.attempted === true), completed: cleanups.length > 0 && cleanups.every(c => c.completed === true),
            errors: cleanups.flatMap(c => c.errors ?? []), leaks: cleanups.flatMap(c => c.leaks ?? []), receipts: cleanups };
        const report = { schemaVersion: 1, kind: 'smoke', name, startedAt, finishedAt: new Date().toISOString(), selection, cleanup, screenshots, placement: 'default',
            provenance, assertions, summary: { assertions: assertions.length, passed: assertions.filter(a => a.ok === true).length, failed: assertions.filter(a => a.ok === false).length, skipped: assertions.filter(a => a.ok === null).length },
            ...(failure ? { harnessFailure: failure } : {}), exitStatus };
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    };
    return Object.assign(finish, { beforeExecution, recordScreenshot(label, file) {
        screenshots.push({ id: `${name}:shot:${label}`, path: path.resolve(file), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), placement: 'default' });
    }, recordCleanup(receipt) {
        cleanups.push(structuredClone(receipt));
        if (receipt.completed !== true || receipt.errors?.length || receipt.leaks?.length) finish(1, { failureClass: 'cleanup', detail: 'desktop teardown incomplete; original failure retained' });
    } });
}

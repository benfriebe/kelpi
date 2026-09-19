#!/usr/bin/env node
/** Run one immutable, self-contained Node test against two explicitly supplied clean worktrees. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest, git, snapshot, startRun, readArtifact, writeAcceptance } from './ui-audit/lib/acceptance-io.mjs';
import { inspectRegression } from './ui-audit/lib/acceptance-incidents.mjs';
import { exitCode } from './ui-audit/lib/acceptance-results.mjs';

export function runRegression({ baseline, candidate, test, args = [], assertions, outRoot, timeoutMs = 120000 }) {
    baseline = fs.realpathSync(baseline); candidate = fs.realpathSync(candidate);
    if ([baseline, candidate].some(root => fs.realpathSync(git(root, ['rev-parse', '--show-toplevel'])) !== root)) throw new Error('supply worktree roots, not subdirectories');
    if (baseline === candidate) throw new Error('baseline and candidate must be distinct explicit worktrees');
    const original = fs.readFileSync(test), baselineState = snapshot(baseline), candidateState = snapshot(candidate);
    if (baselineState.dirty.length || candidateState.dirty.length) throw new Error('baseline and candidate must be clean, including untracked source');
    if (baselineState.head === candidateState.head) throw new Error('baseline and candidate must identify different commits');
    const run = startRun(candidate, { outRoot, args, reference: baselineState.head });
    const source = path.join(run.outDir, 'immutable-test.mjs');
    fs.writeFileSync(source, original, { flag: 'wx', mode: 0o444 });
    run.artifacts.push({ path: source, sha256: digest(original), kind: 'immutable-test' });
    const invocation = { executable: process.execPath, path: source, sha256: digest(original), args };
    const invocationPath = path.join(run.outDir, 'test-invocation.json');
    fs.writeFileSync(invocationPath, `${JSON.stringify(invocation)}\n`, { flag: 'wx' });
    run.artifacts.push({ path: invocationPath, sha256: digest(fs.readFileSync(invocationPath)), kind: 'invocation' });
    const runnerFiles = ['acceptance-regression.mjs', 'ui-audit/lib/acceptance-io.mjs', 'ui-audit/lib/acceptance-incidents.mjs', 'ui-audit/lib/acceptance-results.mjs'];
    const runner = runnerFiles.map((name, index) => {
        const bytes = fs.readFileSync(new URL(name, import.meta.url));
        const file = path.join(run.outDir, `runner-${index}-${path.basename(name)}`);
        fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o444 });
        const artifact = { path: file, sha256: digest(bytes), kind: 'runner-source' };
        run.artifacts.push(artifact); return artifact;
    });
    const report = { schemaVersion: 1, kind: 'incident-regression', runId: run.runId, startedAt: run.startedAt, test: { ...invocation, invocationPath }, runner, artifacts: run.artifacts };
    for (const [role, root] of [['baseline', baseline], ['candidate', candidate]]) {
        const resultPath = path.join(run.outDir, `${role}-assertions.json`), startedAt = Date.now(), before = snapshot(root);
        const env = { ...process.env, KELPI_REGRESSION_ROOT: root, KELPI_REGRESSION_REPORT: resultPath };
        delete env.KELPI_SOCKET; delete env.NEX_SOCKET;
        const unchanged = digest(fs.readFileSync(source)) === report.test.sha256 && before.dirty.length === 0 && before.head === (role === 'baseline' ? baselineState.head : candidateState.head);
        const child = unchanged ? spawnSync(process.execPath, [source, ...args], { cwd: root, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }) : { status: null, error: new Error('test source or worktree changed before attempt') };
        for (const stream of ['stdout', 'stderr']) {
            const file = path.join(run.outDir, `${role}-${stream}.txt`), bytes = child[stream] ?? '';
            fs.writeFileSync(file, bytes, { flag: 'wx' }); run.artifacts.push({ path: file, sha256: digest(bytes), kind: stream });
        }
        const raw = readArtifact(resultPath, run, { startedAt, kind: 'assertions' });
        report[role] = { root, before, after: snapshot(root), startedAt, finishedAt: Date.now(), exitStatus: child.status, signal: child.signal, error: child.error?.message ?? raw.error ?? null, resultPath, stdoutPath: path.join(run.outDir, `${role}-stdout.txt`), stderrPath: path.join(run.outDir, `${role}-stderr.txt`), result: raw.data, testDigestAfter: digest(fs.readFileSync(source)) };
    }
    report.finishedAt = new Date().toISOString();
    const checked = inspectRegression(report, { head: candidateState.head, reference: baselineState.head, assertionNames: assertions });
    const file = path.join(run.outDir, 'regression.json');
    fs.writeFileSync(file, `${JSON.stringify({ ...report, evaluation: checked }, null, 2)}\n`, { flag: 'wx' });
    run.artifacts.push({ path: file, sha256: digest(fs.readFileSync(file)), kind: 'regression' });
    writeAcceptance(run, { verdict: checked.verdict, scope: 'regression evidence only; not PR acceptance', reasons: [...checked.failures, ...checked.missing], end: snapshot(candidate) });
    return { ...checked, path: file, sha256: digest(fs.readFileSync(file)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    try {
        const argv = process.argv.slice(2), value = flag => argv[argv.indexOf(flag) + 1];
        for (const flag of ['--baseline', '--candidate', '--test', '--assertions', '--out']) if (!argv.includes(flag) || !value(flag) || value(flag).startsWith('--')) throw new Error(`required: ${flag}`);
        const divider = argv.indexOf('--');
        const result = runRegression({ baseline: value('--baseline'), candidate: value('--candidate'), test: value('--test'), assertions: value('--assertions').split(','), outRoot: path.resolve(value('--out')), args: divider < 0 ? [] : argv.slice(divider + 1) });
        console.log(JSON.stringify(result, null, 2)); process.exitCode = exitCode(result.verdict);
    } catch (error) { console.error(error.message); process.exitCode = 2; }
}

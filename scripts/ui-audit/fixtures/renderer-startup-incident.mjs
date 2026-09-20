#!/usr/bin/env node
/**
 * Immutable live regression for #239.
 *
 * The supplied clean ref is cloned into a disposable runtime, its real bundles are rebuilt, and
 * one inline script is inserted before the client module.  The script logs one console error and
 * throws one uncaught exception while the first document is still being parsed, before React can
 * mount.  The ref's unchanged scenario runner and production driver then decide whether those
 * events belong to the scenario which follows.
 *
 * This is intentionally an outer test: the fixed candidate's inner scenario run MUST exit 1,
 * because observing a renderer incident is the behavior under test.  The outer fixture exits 0
 * only when that failure is exact, attributed, and observed once.  A missing report, build/boot
 * error, timeout, or absent API is an infrastructure error and can never satisfy the regression.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const STARTUP_CONSOLE = 'kelpi-239-regression-first-document-console';
export const STARTUP_EXCEPTION = 'kelpi-239-regression-first-document-exception';
export const RENDERER_CHECK = 'the renderer threw nothing and logged no error';
export const SHARED_SCENARIO = 'issue-239-shared-startup';
export const DEDICATED_SCENARIO = 'issue-239-dedicated-startup';
const HEALTHY_SCENARIO = 'issue-239-healthy-boot';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function injectStartupIncidentHtml(html) {
    const head = html.match(/<head(?:\s[^>]*)?>/i);
    if (head === null || head.index === undefined) throw new Error('client index has no head element');
    const script = `<script data-kelpi-startup-incident>console.error(${JSON.stringify(STARTUP_CONSOLE)});throw new Error(${JSON.stringify(STARTUP_EXCEPTION)});</script>`;
    return `${html.slice(0, head.index + head[0].length)}\n    ${script}${html.slice(head.index + head[0].length)}`;
}

const occurrences = (text, needle) => String(text ?? '').split(needle).length - 1;
const summaryNamed = (report, name) => Array.isArray(report?.summaries) ? report.summaries.find((summary) => summary?.name === name) : undefined;
const rendererFailures = (summary) => (summary?.results ?? []).filter((item) => item?.label === RENDERER_CHECK && item?.ok === false);

export function assessFaultRun(report, exitStatus) {
    const errors = [];
    const names = [SHARED_SCENARIO, DEDICATED_SCENARIO];
    if (![0, 1].includes(exitStatus)) errors.push(`unexpected inner exit status: ${exitStatus}`);
    if (!Array.isArray(report?.summaries) || report.summaries.length !== names.length ||
        names.some(name => report.summaries.filter(summary => summary?.name === name).length !== 1)) {
        errors.push('fault run must contain exactly the shared and dedicated scenarios');
    }
    if (report?.error || (report?.errors?.length ?? 0) || (report?.leaks?.length ?? 0)) errors.push('fault runner reported an unrelated error or leak');
    let rawFailures = 0;
    for (const name of names) {
        const summary = summaryNamed(report, name);
        const results = summary?.results;
        if (!Array.isArray(results)) { errors.push(`${name}: required results are missing`); continue; }
        const controls = [`${name} native shell identity is live`, `${name} body ran`];
        for (const label of controls) {
            const found = results.filter(item => item?.label === label);
            if (found.length !== 1 || found[0].ok !== true) errors.push(`${name}: prerequisite failed or missing: ${label}`);
        }
        const renderer = results.filter(item => item?.label === RENDERER_CHECK);
        if (results.length !== 3 || renderer.length !== 1 || typeof renderer[0]?.ok !== 'boolean') errors.push(`${name}: malformed fault result shape`);
        if (summary.error || (summary.errors?.length ?? 0) || (summary.leaked?.length ?? 0)) errors.push(`${name}: scenario error or cleanup leak`);
        const failed = results.filter(item => item?.ok === false);
        rawFailures += failed.length;
        if (summary.failed !== failed.length || failed.some(item => item.label !== RENDERER_CHECK)) errors.push(`${name}: unrelated or inconsistent failure count`);
        const detail = renderer[0]?.detail ?? '';
        if (typeof detail !== 'string' || (renderer[0]?.ok === true && detail.length !== 0) ||
            (renderer[0]?.ok === false && (!detail || detail.split(' | ').some(part =>
                !part.includes(STARTUP_CONSOLE) && !part.includes(STARTUP_EXCEPTION))))) {
            errors.push(`${name}: renderer result contains an unrelated error`);
        }
        if ((name === DEDICATED_SCENARIO) !== (summary.ownInstance === true)) errors.push(`${name}: wrong instance attribution`);
    }
    if ([0, 1].includes(exitStatus) && exitStatus !== (rawFailures > 0 ? 1 : 0)) errors.push('inner exit status disagrees with raw failures');
    const assess = (name, ownInstance) => {
        const summary = summaryNamed(report, name);
        const failures = rendererFailures(summary);
        const detail = failures[0]?.detail ?? '';
        const otherFailures = (summary?.results ?? []).filter((item) => item?.ok === false && item?.label !== RENDERER_CHECK);
        return {
            ok: summary !== undefined && summary.failed === 1 && failures.length === 1 && otherFailures.length === 0 &&
                occurrences(detail, STARTUP_CONSOLE) === 1 && occurrences(detail, STARTUP_EXCEPTION) === 1 &&
                detail.split(' | ').length === 2 && (ownInstance ? summary.ownInstance === true : summary.ownInstance !== true),
            summary: summary ?? null,
            markerCounts: {
                console: occurrences(detail, STARTUP_CONSOLE),
                exception: occurrences(detail, STARTUP_EXCEPTION)
            }
        };
    };
    const shared = assess(SHARED_SCENARIO, false);
    const dedicated = assess(DEDICATED_SCENARIO, true);
    return { ok: errors.length === 0 && exitStatus === 1 && shared.ok && dedicated.ok, valid: errors.length === 0, errors, exitStatus, shared, dedicated };
}

export function assessHealthyRun(report, exitStatus, elapsedMs, ceilingMs = 60_000) {
    const summary = summaryNamed(report, HEALTHY_SCENARIO);
    const results = Array.isArray(summary?.results) ? summary.results : [];
    const renderer = results.filter((item) => item?.label === RENDERER_CHECK);
    const controls = [`${HEALTHY_SCENARIO} native shell identity is live`, `${HEALTHY_SCENARIO} body ran`, 'healthy app root mounted'];
    const clean = !report?.error && !(report?.errors?.length ?? 0) && !(report?.leaks?.length ?? 0) &&
        !summary?.error && !(summary?.errors?.length ?? 0) && !(summary?.leaked?.length ?? 0) &&
        results.length === 4 && results.every(item => item?.ok === true) &&
        controls.every(label => results.filter(item => item?.label === label).length === 1);
    return {
        ok: clean && exitStatus === 0 && elapsedMs < ceilingMs && report?.summaries?.length === 1 && summary?.failed === 0 &&
            renderer.length === 1 && renderer[0]?.ok === true,
        exitStatus,
        elapsedMs,
        ceilingMs,
        summary: summary ?? null
    };
}

function writeExclusive(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value, { flag: 'wx' });
}

function writeJson(file, value) {
    writeExclusive(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runLogged({ command, args, cwd, env = process.env, timeout, logPrefix }) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const child = spawnSync(command, args, {
        cwd,
        env,
        encoding: 'utf8',
        timeout,
        maxBuffer: 32 * 1024 * 1024
    });
    const result = {
        command,
        args,
        cwd,
        startedAt,
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
        status: child.status,
        signal: child.signal,
        error: child.error?.message ?? null
    };
    writeExclusive(`${logPrefix}.stdout.txt`, child.stdout ?? '');
    writeExclusive(`${logPrefix}.stderr.txt`, child.stderr ?? '');
    writeJson(`${logPrefix}.command.json`, result);
    return result;
}

function git(root, args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
}

function linkDependencyTrees(sourceRoot, runtimeRoot) {
    const linked = [];
    const visit = (source, relative, depth) => {
        if (depth > 5) return;
        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
            if (!entry.isDirectory() || ['.git', 'dist', 'out', 'docs'].includes(entry.name)) continue;
            const childRelative = path.join(relative, entry.name);
            const childSource = path.join(source, entry.name);
            if (entry.name === 'node_modules') {
                const childRuntime = path.join(runtimeRoot, childRelative);
                fs.mkdirSync(path.dirname(childRuntime), { recursive: true });
                fs.symlinkSync(childSource, childRuntime, 'dir');
                linked.push(childRelative);
            } else {
                visit(childSource, childRelative, depth + 1);
            }
        }
    };
    visit(sourceRoot, '', 0);
    return linked.sort();
}

function hashFiles(root, relatives) {
    return Object.fromEntries(relatives.map((relative) => {
        const bytes = fs.readFileSync(path.join(root, relative));
        return [relative, { sha256: sha256(bytes), bytes: bytes.length }];
    }));
}

export function runningRuntimeProcesses(runtimeRoot, run = spawnSync) {
    const result = run('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string') {
        throw new Error(`runtime process scan failed: ${result.error?.message ?? result.stderr ?? result.signal ?? result.status}`);
    }
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match || Number(match[1]) === process.pid || !match[2].includes(runtimeRoot)) return [];
        return [{ pid: Number(match[1]), command: match[2] }];
    });
}

function stopRuntimeProcesses(runtimeRoot) {
    const before = runningRuntimeProcesses(runtimeRoot);
    for (const item of before) {
        try { process.kill(item.pid, 'SIGTERM'); } catch { /* already exited */ }
    }
    if (before.length) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    const afterTerm = runningRuntimeProcesses(runtimeRoot);
    for (const item of afterTerm) {
        try { process.kill(item.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    if (afterTerm.length) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    return { before, afterTerm, remaining: runningRuntimeProcesses(runtimeRoot) };
}

function scenarioSource(name, { dedicated = false, healthy = false } = {}) {
    return `${dedicated ? "export const windowPlacement = 'offscreen';\n" : ''}export default async function ({ page, rec, d, harness }) {
    const native = await harness.ping();
    rec.check(${JSON.stringify(`${name} native shell identity is live`)}, Number.isInteger(native.pid) && typeof native.version === 'string' && native.version.length > 0, JSON.stringify(native));
    rec.check(${JSON.stringify(`${name} body ran`)}, true);
    ${healthy ? `rec.check('healthy app root mounted', await page.eval(\`document.querySelector('${'${d.PAGE.app}'}') !== null\`));` : ''}
}\n`;
}

function requireSuccessful(command, label) {
    if (command.status !== 0 || command.signal !== null || command.error !== null) {
        throw new Error(`${label} failed: ${JSON.stringify(command)}`);
    }
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { throw new Error(`required JSON report unavailable (${file}): ${error.message}`); }
}

function fact(file, role) {
    const bytes = fs.readFileSync(file);
    return { role, path: file, sha256: sha256(bytes), bytes: bytes.length };
}

async function main() {
    const argv = process.argv.slice(2);
    const value = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
    const requestedRoot = value('--repo') ?? process.env.KELPI_REGRESSION_ROOT;
    const requestedOutput = value('--out') ?? process.env.KELPI_REGRESSION_REPORT;
    if (!requestedRoot) throw new Error('supply --repo or KELPI_REGRESSION_ROOT');
    if (!requestedOutput || !path.isAbsolute(requestedOutput)) throw new Error('supply an absolute --out or KELPI_REGRESSION_REPORT');
    const sourceRoot = fs.realpathSync(requestedRoot);
    const output = path.resolve(requestedOutput);
    const outputRelative = path.relative(sourceRoot, output);
    if (!outputRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(outputRelative)) throw new Error('regression report must be outside the source checkout');
    if (fs.existsSync(output) || fs.existsSync(`${output}.artifacts`)) throw new Error('refusing to overwrite retained regression evidence');
    const artifactRoot = `${output}.artifacts`;
    fs.mkdirSync(artifactRoot, { recursive: true });

    const assertions = [];
    const errors = [];
    const observations = {};
    const cleanup = { attempted: false, completed: false, errors: [], leaks: [], forcedProcesses: [] };
    const check = (name, ok, detail) => assertions.push({ name, ok: ok === true, detail });
    const sourceBefore = { head: git(sourceRoot, ['rev-parse', 'HEAD']), dirty: git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean) };
    let runtimeParent;
    let runtimeRoot;
    try {
        if (sourceBefore.dirty.length) throw new Error(`source ref is dirty: ${sourceBefore.dirty.join(', ')}`);
        if (fs.realpathSync(git(sourceRoot, ['rev-parse', '--show-toplevel'])) !== sourceRoot) throw new Error('supply an exact worktree root');

        runtimeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-239-live-'));
        runtimeRoot = path.join(runtimeParent, 'runtime');
        const clone = runLogged({ command: 'git', args: ['clone', '--shared', '--no-checkout', sourceRoot, runtimeRoot], cwd: runtimeParent, timeout: 60_000, logPrefix: path.join(artifactRoot, 'clone') });
        requireSuccessful(clone, 'temporary exact-ref clone');
        const checkout = runLogged({ command: 'git', args: ['checkout', '--detach', sourceBefore.head], cwd: runtimeRoot, timeout: 60_000, logPrefix: path.join(artifactRoot, 'checkout') });
        requireSuccessful(checkout, 'temporary exact-ref checkout');
        const linkedNodeModules = linkDependencyTrees(sourceRoot, runtimeRoot);

        const buildCommands = [
            ['pnpm', ['--filter', '@kelpi/daemon', 'build']],
            ['pnpm', ['--filter', '@kelpi/cli', 'build']],
            ['pnpm', ['--filter', '@kelpi/client', 'build']],
            ['pnpm', ['--filter', '@kelpi/shell', 'build']]
        ];
        observations.build = [];
        for (const [index, [command, args]] of buildCommands.entries()) {
            const built = runLogged({ command, args, cwd: runtimeRoot, timeout: 90_000, logPrefix: path.join(artifactRoot, `build-${index}`) });
            observations.build.push(built);
            requireSuccessful(built, `exact-ref build ${index}`);
        }

        const scenarioDir = path.join(artifactRoot, 'scenarios');
        const healthyScenario = path.join(scenarioDir, `${HEALTHY_SCENARIO}.mjs`);
        const sharedScenario = path.join(scenarioDir, `${SHARED_SCENARIO}.mjs`);
        const dedicatedScenario = path.join(scenarioDir, `${DEDICATED_SCENARIO}.mjs`);
        writeExclusive(healthyScenario, scenarioSource(HEALTHY_SCENARIO, { healthy: true }));
        writeExclusive(sharedScenario, scenarioSource(SHARED_SCENARIO));
        writeExclusive(dedicatedScenario, scenarioSource(DEDICATED_SCENARIO, { dedicated: true }));

        const runScenario = (label, scenarios) => {
            const out = path.join(artifactRoot, label);
            const command = runLogged({
                command: process.execPath,
                args: [path.join(runtimeRoot, 'scripts', 'scenario.mjs'), ...scenarios, '--no-build', '--window', 'hidden', '--out', out],
                cwd: runtimeRoot,
                timeout: 75_000,
                logPrefix: path.join(artifactRoot, label)
            });
            const report = readJson(path.join(out, 'results.json'));
            return { command, report, reportPath: path.join(out, 'results.json') };
        };

        const healthy = runScenario('healthy', [healthyScenario]);
        observations.healthy = assessHealthyRun(healthy.report, healthy.command.status, healthy.command.elapsedMs);
        if (!observations.healthy.ok) throw new Error(`healthy native Electron boot control failed: ${JSON.stringify(observations.healthy)}`);
        check('healthy-native-electron-boot-is-prompt-and-clean', observations.healthy.ok, observations.healthy);

        const clientIndex = path.join(runtimeRoot, 'packages', 'client', 'dist', 'index.html');
        const cleanIndex = fs.readFileSync(clientIndex, 'utf8');
        const injectedIndex = injectStartupIncidentHtml(cleanIndex);
        fs.writeFileSync(clientIndex, injectedIndex);
        observations.injection = {
            path: clientIndex,
            cleanSha256: sha256(cleanIndex),
            injectedSha256: sha256(injectedIndex),
            consoleOccurrences: occurrences(injectedIndex, STARTUP_CONSOLE),
            exceptionOccurrences: occurrences(injectedIndex, STARTUP_EXCEPTION),
            beforeFirstModule: injectedIndex.indexOf('data-kelpi-startup-incident') < injectedIndex.search(/<script[^>]+type=["']module["']/i)
        };
        if (!observations.injection.beforeFirstModule || observations.injection.consoleOccurrences !== 1 || observations.injection.exceptionOccurrences !== 1) {
            throw new Error(`startup incident injection is not exact: ${JSON.stringify(observations.injection)}`);
        }

        const fault = runScenario('fault', [sharedScenario, dedicatedScenario]);
        if (fault.command.error || fault.command.signal) throw new Error(`fault runner could not complete: ${JSON.stringify(fault.command)}`);
        observations.fault = assessFaultRun(fault.report, fault.command.status);
        if (!observations.fault.valid) throw new Error(`fault run is not a valid incident observation: ${JSON.stringify(observations.fault.errors)}`);
        check('shared-first-document-errors-fail-responsible-scenario-exactly-once', observations.fault.shared.ok, observations.fault.shared);
        check('dedicated-first-document-errors-fail-responsible-scenario-exactly-once', observations.fault.dedicated.ok, observations.fault.dedicated);
        check('captured-startup-incidents-produce-one-failed-inner-run', observations.fault.ok, observations.fault);

        const critical = [
            'scripts/scenario.mjs',
            'scripts/ui-audit/lib/driver.mjs',
            'packages/shell/src/main.ts',
            'packages/shell/dist/main.js',
            'packages/daemon/dist/kelpid.js',
            'packages/cli/dist/kelpi.js'
        ];
        const runtimeStatus = git(runtimeRoot, ['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean);
        const dependencyStatuses = new Set(linkedNodeModules.map((relative) => `?? ${relative}`));
        observations.identity = {
            requestedRoot: sourceRoot,
            requestedHead: sourceBefore.head,
            runtimeRoot,
            runtimeHead: git(runtimeRoot, ['rev-parse', 'HEAD']),
            runtimeDirty: runtimeStatus.filter((line) => !dependencyStatuses.has(line)),
            dependencyLinks: runtimeStatus.filter((line) => dependencyStatuses.has(line)),
            linkedNodeModules,
            files: hashFiles(runtimeRoot, critical),
            scenarioSources: hashFiles('/', [healthyScenario, sharedScenario, dedicatedScenario])
        };
        check('runtime-used-the-requested-clean-source-commit', observations.identity.runtimeHead === sourceBefore.head && observations.identity.runtimeDirty.length === 0, observations.identity);
    } catch (error) {
        errors.push({ kind: 'infrastructure/config/import', message: String(error?.stack ?? error) });
    } finally {
        cleanup.attempted = true;
        let processScanCompleted = !runtimeRoot;
        if (runtimeRoot) {
            try {
                const stopped = stopRuntimeProcesses(runtimeRoot);
                processScanCompleted = stopped.remaining.length === 0;
                cleanup.forcedProcesses = stopped.before;
                if (stopped.remaining.length) cleanup.leaks.push(...stopped.remaining.map((item) => `pid ${item.pid}: ${item.command}`));
                if (stopped.before.length) cleanup.errors.push(`scenario runner left ${stopped.before.length} runtime process(es); fixture terminated them`);
            } catch (error) { cleanup.errors.push(`process cleanup could not be verified: ${error.message}`); }
        }
        if (runtimeParent && processScanCompleted) {
            const tempRoot = fs.realpathSync(os.tmpdir());
            const normalizedRuntime = fs.realpathSync(runtimeParent);
            const safeRuntime = path.dirname(normalizedRuntime) === tempRoot && path.basename(normalizedRuntime).startsWith('kelpi-239-live-');
            if (!safeRuntime) cleanup.errors.push(`refusing to remove unexpected runtime path: ${runtimeParent} (${normalizedRuntime})`);
            else {
                try { fs.rmSync(normalizedRuntime, { recursive: true, force: true }); }
                catch (error) { cleanup.errors.push(`temporary runtime removal: ${error.message}`); }
            }
        }
        cleanup.completed = cleanup.errors.length === 0 && cleanup.leaks.length === 0 && (!runtimeParent || !fs.existsSync(runtimeParent));
    }

    const sourceAfter = {
        head: git(sourceRoot, ['rev-parse', 'HEAD']),
        dirty: git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean)
    };
    check('source-checkout-remained-read-only-and-clean', sourceAfter.head === sourceBefore.head && sourceAfter.dirty.length === 0, { sourceBefore, sourceAfter });
    check('all-live-child-processes-and-temporary-runtime-were-cleaned', cleanup.completed, cleanup);

    const identityPath = path.join(artifactRoot, 'runtime-identity.json');
    const observationsPath = path.join(artifactRoot, 'observations.json');
    const cleanupPath = path.join(artifactRoot, 'cleanup.json');
    writeJson(identityPath, { sourceBefore, sourceAfter, identity: observations.identity ?? null, injection: observations.injection ?? null });
    writeJson(observationsPath, observations);
    writeJson(cleanupPath, cleanup);
    const logFacts = fs.readdirSync(artifactRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(?:txt|json)$/.test(entry.name))
        .map((entry) => path.join(entry.parentPath, entry.name))
        .filter((file) => file !== output)
        .map((file) => fact(file, file.endsWith('results.json') ? 'scenario-report' : 'runtime-log'));
    const fixturePath = fileURLToPath(import.meta.url);
    const report = {
        schemaVersion: 1,
        assertions,
        errors,
        environment: {
            id: `${os.hostname()}:${process.platform}:${process.arch}:${process.version}:electron-cdp`,
            kind: 'local',
            details: 'Real private Electron shells and daemons driven by each exact ref\'s unchanged production scenario runner/driver over CDP; disposable exact-ref clone with one recorded built-index incident injection.',
            evidence: { facts: [fact(identityPath, 'source'), fact(observationsPath, 'session'), fact(cleanupPath, 'cleanup'), ...logFacts] }
        },
        cleanup,
        fixture: { path: fixturePath, sha256: sha256(fs.readFileSync(fixturePath)) },
        source: { root: sourceRoot, head: sourceBefore.head, dirtyFiles: sourceAfter.dirty },
        observations,
        limitations: [
            'Local macOS Electron/CDP proof only; it does not certify an installed app, remote transport, Safari, phone, or native IME.',
            'The controlled incident changes only disposable built index.html bytes; production source and the production driver/scenario runner remain unchanged.',
            'The inner candidate run is expected to fail because correct incident capture makes its responsible scenarios fail; the outer fixture validates that exact failure.'
        ]
    };
    writeJson(output, report);
    console.log(JSON.stringify({ head: sourceBefore.head, assertions: assertions.map(({ name, ok }) => ({ name, ok })), errors, cleanup, reportPath: output }));
    process.exitCode = errors.length ? 2 : assertions.some((assertion) => !assertion.ok) ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]))) {
    main().catch((error) => {
        console.error(error?.stack ?? error);
        process.exitCode = 2;
    });
}

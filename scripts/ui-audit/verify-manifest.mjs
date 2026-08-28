#!/usr/bin/env node
/**
 * The evidence behind `lib/shards.mjs`'s `free` lane, re-runnable.
 *
 * A sharded run is only correct if the steps it moves out of the serial spine really are
 * self-provisioning — if each one produces every precondition it asserts on, instead of quietly
 * inheriting one from a step that happened to run before it. Reading 15,000 lines of flow bodies
 * is one way to believe that. Measuring it is better:
 *
 *   for each candidate step, run the audit with `--only <id>` in its own fresh sandbox, from a
 *   cold boot, and compare the step's assertion list — names, order, pass/fail — against the same
 *   step in the baseline run, where it ran after up to a hundred others.
 *
 * A step that reproduces its baseline result with nothing before it does not depend on anything
 * before it, and is safe in any shard. A step that does not is a candidate for the spine — but not
 * automatically a member of it: "alone" is stricter than "in the free lane", where the earlier FREE
 * steps still run in canonical order. `settings-tab-*` fails here for exactly that reason (nothing
 * has opened Settings) and is perfectly safe in a shard that also holds `settings-open`. So this
 * produces the SHORTLIST; the verdict is a real `--shards N` run diffed with `compare-runs.mjs`,
 * and each manifest entry records which of the two moved it.
 *
 * This is the same comparison `compare-runs.mjs` makes, applied one step at a time; `detail`
 * strings, notes and timings are excluded for the same reason (they carry live values).
 *
 * Usage:
 *
 *     node scripts/ui-audit/verify-manifest.mjs --out <dir> [--baseline docs/audit/run-AH2/results.json]
 *          X
 *
 * Exit code 0 = every candidate reproduced its baseline result.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STEP_MANIFEST } from './lib/shards.mjs';
import { clearBackgroundTaskPolicy } from './lib/stack.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
};

const options = {
    out: path.resolve(repoRoot, flag('out', path.join('docs', 'audit', 'manifest-verify'))),
    baseline: path.resolve(repoRoot, flag('baseline', path.join('docs', 'audit', 'run-AH2', 'results.json'))),
    lane: flag('lane', 'free'),
    jobs: Number(flag('jobs', '4')),
    window: flag('window', 'hidden'),
    only: (flag('only', '') ?? '').split(',').filter(Boolean)
};

const baseline = JSON.parse(fs.readFileSync(options.baseline, 'utf8'));
const baseByID = new Map(baseline.steps.map((step) => [step.id, step]));

const candidates = STEP_MANIFEST.filter(
    (entry) => (options.lane === 'all' || entry.lane === options.lane) && (options.only.length === 0 || options.only.includes(entry.id))
);

fs.mkdirSync(options.out, { recursive: true });
process.stdout.write(
    `verifying ${String(candidates.length)} "${options.lane}" step(s) alone, ${String(options.jobs)} at a time, window=${options.window}\n` +
        `baseline: ${options.baseline}\n\n`
);

/** Run one step alone and return its recorded entry, or an error. */
function runAlone(id) {
    const dir = path.join(options.out, id);
    return new Promise((resolve) => {
        const child = spawn(
            process.execPath,
            [path.join(here, 'audit.mjs'), '--out', dir, '--no-build', '--window', options.window, '--only', id],
            { cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        clearBackgroundTaskPolicy(child.pid);
        const sink = fs.createWriteStream(path.join(options.out, `${id}.log`));
        child.stdout.pipe(sink);
        child.stderr.pipe(sink);
        const started = Date.now();
        child.on('close', (code) => {
            const seconds = (Date.now() - started) / 1000;
            let entry = null;
            try {
                const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
                entry = parsed.steps.find((step) => step.id === id) ?? null;
            } catch {
                entry = null;
            }
            resolve({ id, code: code ?? -1, seconds, entry });
        });
        child.on('error', () => resolve({ id, code: -1, seconds: 0, entry: null }));
    });
}

/**
 * An assertion's identity with the live values taken out — the same normalisation
 * `compare-runs.mjs` applies, and for the same reason: several steps build the assertion NAME
 * from a pane or workspace id, so raw names report every run as a wall of removed-and-added
 * pairs. The count, the order and the verdict are all still compared.
 */
const normalizeName = (name) =>
    String(name)
        .replace(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g, '<id>')
        .replace(/\b[0-9A-F]{8}\b/g, '<id>');

/** The same verdict `compare-runs.mjs` reaches, for one step. */
function diffStep(base, solo) {
    const notes = [];
    if (base === undefined) return ['the baseline has no such step'];
    if (solo === null) return ['the solo run produced no entry for it (harness failure — see the log)'];
    if (base.assertions.length !== solo.assertions.length) {
        notes.push(`assertion count ${String(base.assertions.length)} → ${String(solo.assertions.length)}`);
    }
    const names = (step) => step.assertions.map((assertion) => normalizeName(assertion.name));
    if (names(base).join(' ') !== names(solo).join(' ')) {
        const onlyBase = names(base).filter((name) => !names(solo).includes(name));
        const onlySolo = names(solo).filter((name) => !names(base).includes(name));
        if (onlyBase.length + onlySolo.length === 0) notes.push('assertion order differs');
        else {
            for (const name of onlyBase.slice(0, 4)) notes.push(`− ${name}`);
            for (const name of onlySolo.slice(0, 4)) notes.push(`+ ${name}`);
        }
    }
    // Positional, so a step that legitimately asserts the same normalised name once per pane
    // keeps one verdict per occurrence instead of collapsing them.
    const verdicts = new Map(base.assertions.map((assertion, i) => [`${String(i)}:${normalizeName(assertion.name)}`, assertion.ok]));
    for (const [i, assertion] of solo.assertions.entries()) {
        const key = `${String(i)}:${normalizeName(assertion.name)}`;
        if (!verdicts.has(key)) continue;
        if (verdicts.get(key) !== assertion.ok) {
            notes.push(`${assertion.ok ? 'now GREEN (was red)' : 'now RED (was green)'}: ${assertion.name} — ${assertion.detail}`);
        }
    }
    const errored = (step) => step.error !== null && step.error !== undefined;
    if (!errored(base) && errored(solo)) notes.push(`step ERRORED alone: ${String(solo.error).split('\n')[0]}`);
    return notes;
}

const results = [];
let cursor = 0;
async function worker() {
    for (;;) {
        const index = cursor++;
        if (index >= candidates.length) return;
        const { id } = candidates[index];
        const outcome = await runAlone(id);
        const notes = diffStep(baseByID.get(id), outcome.entry);
        const ok = notes.length === 0 && outcome.code === 0;
        results.push({ id, ok, notes, seconds: outcome.seconds, exit: outcome.code });
        process.stdout.write(
            `${ok ? '✓' : '✗'} ${id.padEnd(36)} ${outcome.seconds.toFixed(0).padStart(4)}s` +
                `${ok ? '' : `\n      ${notes.join('\n      ')}`}\n`
        );
    }
}

await Promise.all(Array.from({ length: Math.max(1, options.jobs) }, () => worker()));

results.sort((a, b) => candidates.findIndex((c) => c.id === a.id) - candidates.findIndex((c) => c.id === b.id));
const failed = results.filter((result) => !result.ok);
fs.writeFileSync(
    path.join(options.out, 'verify.json'),
    `${JSON.stringify({ baseline: options.baseline, lane: options.lane, window: options.window, results }, null, 2)}\n`
);
process.stdout.write(
    `\n${String(results.length - failed.length)}/${String(results.length)} reproduced their baseline result alone.\n` +
        `${failed.length === 0 ? 'The free lane is self-provisioning.' : `Move these to the spine: ${failed.map((f) => f.id).join(', ')}`}\n` +
        `report: ${path.join(options.out, 'verify.json')}\n`
);
process.exitCode = failed.length === 0 ? 0 : 1;

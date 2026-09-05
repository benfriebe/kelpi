#!/usr/bin/env node
/**
 * Extract the wire protocol's three machine-checkable tables out of the spec prose and write
 * them to `src/wire/spec-snapshot.json`, which IS committed.
 *
 * WHY THIS EXISTS
 * ---------------
 * `spec-conformance.test.ts` used to `readFileSync` the spec directly. `docs/` is gitignored
 * (`.gitignore:11`), so that test failed at collection time in every fresh worktree:
 *
 *   Error: ENOENT: no such file or directory, open '.../docs/current/wire-protocol.md'
 *
 * which made `pnpm test` red for anyone who had not copied `docs/` in by hand, for a reason
 * that had nothing to do with their change. A test may not depend on an ignored file. So the
 * spec's content is snapshotted into the package, the test reads the snapshot, and the doc
 * stays ignored.
 *
 * WHAT PROTECTS THE SNAPSHOT FROM GOING STALE
 * -------------------------------------------
 * The original guard is split in two, and both halves still run:
 *
 *   - snapshot vs TypeScript is `spec-conformance.test.ts`, which runs everywhere including a
 *     fresh worktree. It is the half that catches an edit to allowlist.ts / messages.ts /
 *     fields.ts, and it keeps this file's "is it substantial" floors so an empty snapshot cannot
 *     make every conformance assertion vacuous;
 *   - spec vs snapshot is `--check` below, wired into `scripts/verify.mjs` after typecheck. It
 *     needs the doc, so it lives outside the test suite.
 *
 * The test cannot simply import this parser and re-check the doc itself: packages/protocol's
 * tsconfig is `include: ["src"]` with `rootDir: "src"`, so a test importing ../../scripts/*.mjs
 * breaks `tsc -b`. That is why the parsing lives here and the doc-side check lives in verify.
 *
 * `--check` with `docs/` absent prints that it skipped and passes, so it is never a silent
 * no-op; a regeneration with `docs/` absent refuses rather than writing an empty snapshot.
 *
 * Regenerate after editing the spec:
 *
 *   node packages/protocol/scripts/snapshot-wire-spec.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

export const SPEC_RELATIVE_PATH = 'docs/current/wire-protocol.md';
export const SNAPSHOT_RELATIVE_PATH = 'packages/protocol/src/wire/spec-snapshot.json';

export function specPath(root = repoRoot) {
    return path.join(root, SPEC_RELATIVE_PATH);
}

export function snapshotPath(root = repoRoot) {
    return path.join(root, SNAPSHOT_RELATIVE_PATH);
}

/** §4: the fenced block under "Reply allowlist", whitespace/comma separated. */
export function allowlistFromSpec(spec) {
    const section = spec.split('## 4. Reply allowlist')[1];
    if (section === undefined) throw new Error('spec section "## 4. Reply allowlist" not found');
    const fenced = /```([\s\S]*?)```/.exec(section);
    if (fenced === null) throw new Error('no fenced block under "## 4. Reply allowlist"');
    return (fenced[1] ?? '')
        .split(/[\s,]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
}

/** §6.0: the summary table's command column plus its R/R vs F&F mode. */
export function commandTableFromSpec(spec) {
    const section = spec.split('### 6.0 Summary table')[1]?.split('### 6.1')[0] ?? '';
    const rows = [];
    for (const line of section.split('\n')) {
        const match = /^\|\s*`([a-z0-9-]+)`\s*\|\s*(R\/R|F&F)\s*\|/.exec(line);
        if (match) rows.push({ command: match[1], mode: match[2] });
    }
    return rows;
}

/** The spec's type names, as they appear in the §7 table, mapped onto `WireFieldKind`. */
const SPEC_TYPE_NAMES = {
    string: 'string',
    'string (UUID)': 'uuid',
    int: 'int',
    bool: 'bool',
    uint64: 'uint64',
    double: 'double',
    'string[]': 'string[]'
};

/** §7: the full wire-field dictionary, as `{ field: kind }`. */
export function fieldDictionaryFromSpec(spec) {
    const section = spec.split('## 7. Full wire-field dictionary')[1]?.split('## 8.')[0] ?? '';
    const fields = {};
    for (const line of section.split('\n')) {
        const match = /^\|\s*(`[^|]+`)\s*\|\s*([^|]+?)\s*\|/.exec(line);
        if (match === null) continue;
        const kind = SPEC_TYPE_NAMES[match[2]];
        if (kind === undefined) continue;
        for (const name of match[1].matchAll(/`([a-z0-9_]+)`/g)) fields[name[1]] = kind;
    }
    return fields;
}

/**
 * The whole snapshot, from spec text. Keys are sorted so a regeneration produces a stable
 * diff: a reviewer should see the semantic change, never a reshuffle.
 */
export function snapshotFromSpec(spec) {
    const fields = fieldDictionaryFromSpec(spec);
    return {
        source: SPEC_RELATIVE_PATH,
        regenerate: `node ${path.posix.join('packages', 'protocol', 'scripts', 'snapshot-wire-spec.mjs')}`,
        replyAllowlist: [...allowlistFromSpec(spec)].sort(),
        commands: [...commandTableFromSpec(spec)].sort((a, b) => a.command.localeCompare(b.command)),
        fields: Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)))
    };
}

/**
 * Sanity floors, mirroring the assertions the test used to make against the spec directly. A
 * parser that silently matched nothing (a renamed heading, a reformatted table) would otherwise
 * write an empty snapshot and turn every conformance assertion into a tautology.
 */
export function assertSnapshotIsSubstantial(snapshot) {
    const problems = [];
    if (snapshot.replyAllowlist.length <= 50) problems.push(`replyAllowlist has ${String(snapshot.replyAllowlist.length)} entries (expected > 50)`);
    if (snapshot.commands.length <= 60) problems.push(`commands has ${String(snapshot.commands.length)} rows (expected > 60)`);
    if (Object.keys(snapshot.fields).length <= 60) problems.push(`fields has ${String(Object.keys(snapshot.fields).length)} entries (expected > 60)`);
    if (problems.length > 0) {
        throw new Error(
            `the spec parser produced an implausibly small snapshot, so the spec's shape probably changed:\n  ${problems.join('\n  ')}`
        );
    }
}

// ── cli ─────────────────────────────────────────────────────────────────────────────

if (process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const check = process.argv.includes('--check');
    const spec = specPath();

    if (!fs.existsSync(spec)) {
        // Absent `docs/` is the normal state of a fresh worktree, not a failure. `--check` says so
        // and passes; a regeneration cannot proceed and says why.
        if (check) {
            console.log(`[wire-spec] ${SPEC_RELATIVE_PATH} is absent (docs/ is gitignored): snapshot drift not checked.`);
            process.exit(0);
        }
        console.error(`cannot regenerate: ${spec} is missing.`);
        console.error('`docs/` is gitignored, so a fresh worktree does not have it. Copy it in from a');
        console.error('checkout that does, then run this again.');
        process.exit(1);
    }

    const fromSpec = snapshotFromSpec(fs.readFileSync(spec, 'utf8'));
    assertSnapshotIsSubstantial(fromSpec);
    const serialized = `${JSON.stringify(fromSpec, null, 4)}\n`;

    if (check) {
        const committed = fs.existsSync(snapshotPath()) ? fs.readFileSync(snapshotPath(), 'utf8') : '';
        if (committed !== serialized) {
            console.error(`[wire-spec] ${SNAPSHOT_RELATIVE_PATH} is out of date with ${SPEC_RELATIVE_PATH}.`);
            console.error(`[wire-spec] the spec changed and the snapshot did not. Regenerate it:`);
            console.error(`[wire-spec]   ${fromSpec.regenerate}`);
            process.exit(1);
        }
        console.log(`[wire-spec] snapshot matches ${SPEC_RELATIVE_PATH}.`);
        process.exit(0);
    }

    fs.writeFileSync(snapshotPath(), serialized);
    console.log(
        `wrote ${SNAPSHOT_RELATIVE_PATH}: ${String(fromSpec.replyAllowlist.length)} allowlisted, ` +
            `${String(fromSpec.commands.length)} commands, ${String(Object.keys(fromSpec.fields).length)} fields`
    );
}

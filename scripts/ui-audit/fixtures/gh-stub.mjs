#!/usr/bin/env node
/**
 * The `gh` every sandbox daemon runs (workspace-feature.md §11): no sandbox ever reaches GitHub.
 *
 * `makeSandbox` points the daemon's `KELPI_GH` at a two-line shell wrapper that execs this file,
 * and `KELPI_AUDIT_GH_CONTROL` at a JSON file under the sandbox root that a scenario writes with
 * `driver.scriptGh(sandbox, control)`. With no control file this is a `gh` that is installed but
 * logged out, so the daemon stands its PR lookups down after one probe, and every other scenario
 * sees no PR glyphs at all. With one:
 *
 *     { "loggedIn": true, "pulls": { "<branch>": [ <gh pr list --json objects> ] } }
 *
 * `gh auth status` reports github.com as logged in, and `gh pr list --head=<branch>` prints that
 * branch's array (or `[]`). Every call's arguments are appended, one JSON array per line, to the
 * control file's path plus `.calls`, so a step can check what the daemon asked for.
 */

import fs from 'node:fs';

const args = process.argv.slice(2);
const controlPath = process.env['KELPI_AUDIT_GH_CONTROL'] ?? '';

if (controlPath !== '') {
    try {
        fs.appendFileSync(`${controlPath}.calls`, `${JSON.stringify(args)}\n`);
    } catch {
        // The sandbox may be going away; the answer below still matters more than the log.
    }
}

let control = null;
try {
    control = controlPath === '' ? null : JSON.parse(fs.readFileSync(controlPath, 'utf8'));
} catch {
    control = null;
}

const loggedOut = 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n';

if (args[0] === 'auth' && args[1] === 'status') {
    if (control?.loggedIn === true) {
        process.stdout.write('github.com\n  ✓ Logged in to github.com account kelpi-audit (keyring)\n');
        process.exit(0);
    }
    process.stderr.write(loggedOut);
    process.exit(1);
}

if (args[0] === 'pr' && args[1] === 'list') {
    if (control?.loggedIn !== true) {
        process.stderr.write(loggedOut);
        process.exit(4);
    }
    const head = args.find((arg) => arg.startsWith('--head='))?.slice('--head='.length) ?? '';
    const pulls = control.pulls?.[head] ?? [];
    process.stdout.write(`${JSON.stringify(pulls)}\n`);
    process.exit(0);
}

process.stderr.write(`gh-stub: unsupported command: ${args.join(' ')}\n`);
process.exit(1);

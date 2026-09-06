/**
 * The scenario rule, as a pure function.
 *
 * WHAT THE RULE IS
 * ----------------
 * `scripts/ui-audit/README.md` has said since #65 that a change to a UI surface ships with a
 * scenario (or an audit step) that exercises it against the real app, and that "verify.mjs does
 * not yet enforce this; until it does, the reviewer asks". Asking did not work: issues #47, #53
 * and #55 were each fixed with unit tests alone, the promote's "full audit passed" never pressed
 * what they changed, and all three shipped broken. This module is that rule with teeth.
 *
 * Three decisions, all made here so `verify.mjs` stays a runner and so every one of them is
 * testable without booting an app:
 *
 *   1. is a changed file a UI surface? (`isUiFile`)
 *   2. which scenarios does this diff have to run? (`covers` declarations plus the scenario
 *      files the diff itself edits)
 *   3. may this diff ship at all, or is it a UI change with nothing exercising it?
 *
 * WHY `covers` EXISTS. A scenario names the source it drives:
 *
 *     export const covers = ['packages/client/src/chrome/Sidebar.tsx', 'packages/shell/src/menu.ts'];
 *
 * Without it the only scenarios a diff could select are the ones the diff happens to edit, which
 * is the wrong set twice over: a Sidebar.tsx change re-runs nothing, and a scenario nobody
 * touched never guards anything again. With it, the sidebar's confirmation keys are re-pressed
 * whenever the sidebar moves, which is the whole point of writing them down once.
 *
 * WHY THE OPT-OUT IS A FLAG AND NOT A HEURISTIC. A rule that exempts "pure refactors" is a rule
 * that exempts everything, because every diff argues it is one. `--no-scenario "<reason>"` is the
 * only way past, it is typed by a person (or by an agent that has to say why), it is printed in
 * the run's output, and it lands in the report file. A skipped check that leaves no trace is
 * indistinguishable from a check that passed.
 */

// ── what the rule reads ─────────────────────────────────────────────────────────────

/**
 * A change under these is a UI surface unless the surface map says otherwise: everything the
 * client renders, and the main process that owns the native surfaces around it (menu,
 * accelerators, dialogs, dock, window). Deliberately whole-tree rather than a list of component
 * dirs: `connection/`, `state/` and `styles.css` are not things you look at, but they are things
 * every surface you DO look at is made of, and the rule is cheapest to obey when it is impossible
 * to argue with. A surface entry may set `ui: true` to opt a path outside these in.
 */
export const UI_PREFIXES = ['packages/client/src/', 'packages/shell/src/'];

/** Where scenarios live. A file added or edited here is proof the diff shipped with one. */
export const SCENARIO_PREFIX = 'scripts/scenarios/';

/**
 * The audit is the other honest answer to "what exercises this?", so editing it discharges the
 * rule too. One file, because the battery IS one file (29,000 lines); when its steps are split
 * out, add the directory here.
 */
export const AUDIT_STEP_FILES = ['scripts/ui-audit/audit.mjs'];

// ── path matching ───────────────────────────────────────────────────────────────────

/**
 * Does a `covers` entry claim this file? Entries are exact paths or directory prefixes, and a
 * bare directory name is treated as a directory: `chrome` must not claim `chromeless.ts`, which
 * a naive `startsWith` would hand it.
 */
export function coversPath(entry, file) {
    if (entry === file) return true;
    return file.startsWith(entry.endsWith('/') ? entry : `${entry}/`);
}

/**
 * Is this file a UI surface? The surface map gets the first word, because it already knows which
 * paths are documentation and which are the harness itself: neither is ever UI, and the harness
 * exemption is what keeps this module from demanding a scenario for the scenario runner.
 */
export function isUiFile(file, { surfaces = [], uiPrefixes = UI_PREFIXES } = {}) {
    const surface = surfaces.find((entry) => file.startsWith(entry.prefix));
    if (surface?.ui === true) return true;
    if (surface?.skip === true || surface?.harness === true) return false;
    return uiPrefixes.some((prefix) => file.startsWith(prefix));
}

/** `scripts/scenarios/confirm-dialog-keys.mjs` -> `confirm-dialog-keys`. */
const scenarioName = (file) => file.slice(file.lastIndexOf('/') + 1).replace(/\.mjs$/, '');

// ── the plan ────────────────────────────────────────────────────────────────────────

/**
 * Decide, for one diff, which scenarios run and whether the diff is allowed through.
 *
 * @param {object} input
 * @param {string[]} input.changed   every path in the diff, repo-relative.
 * @param {string[]} [input.changedScenarioFiles]  paths under `SCENARIO_PREFIX` this change adds
 *        or edits. Defaults to the ones visible in `changed`, but the caller SHOULD pass its own:
 *        `git diff` cannot see an untracked file, so a brand-new scenario written beside the fix
 *        it proves would otherwise be invisible and the rule would refuse the very diff that
 *        obeyed it.
 * @param {{name: string, file: string, covers?: string[]}[]} [input.scenarios]  what is on disk.
 * @param {object[]} [input.surfaces]  the `SURFACES` map, consulted for `ui` / `skip` / `harness`.
 * @param {string|null} [input.noScenario]  the `--no-scenario` reason, or null.
 * @returns {{ok: boolean, uiFiles: string[], uncovered: string[], run: string[],
 *            coverage: Record<string, string[]>, changedScenarios: string[],
 *            changedAuditFiles: string[], optOut: {reason: string}|null, message: string|null}}
 */
export function planScenarios({
    changed = [],
    changedScenarioFiles,
    scenarios = [],
    surfaces = [],
    noScenario = null
} = {}) {
    const uiFiles = changed.filter((file) => isUiFile(file, { surfaces }));

    // Which scenario claims which changed file. Kept as a map rather than a boolean so the plan
    // can say "Sidebar.tsx: confirm-dialog-keys" and a reader can check the claim.
    const coverage = {};
    const run = new Set();
    for (const scenario of scenarios) {
        const hits = changed.filter((file) => (scenario.covers ?? []).some((entry) => coversPath(entry, file)));
        if (hits.length === 0) continue;
        run.add(scenario.name);
        for (const file of hits) coverage[file] = [...(coverage[file] ?? []), scenario.name];
    }

    const touched = (changedScenarioFiles ?? changed.filter((file) => file.startsWith(SCENARIO_PREFIX) && file.endsWith('.mjs')));
    // A scenario the diff DELETES is in the diff and not on disk. It neither runs nor counts as
    // shipping one, which is the honest reading of "ships with a scenario".
    const changedScenarios = touched
        .map(scenarioName)
        .filter((name) => scenarios.some((scenario) => scenario.name === name));
    for (const name of changedScenarios) run.add(name);

    const changedAuditFiles = changed.filter((file) => AUDIT_STEP_FILES.includes(file));
    const uncovered = uiFiles.filter((file) => coverage[file] === undefined);
    const shippedProof = changedScenarios.length > 0 || changedAuditFiles.length > 0;
    const optOut = typeof noScenario === 'string' && noScenario.trim() !== '' ? { reason: noScenario.trim() } : null;
    const ok = uncovered.length === 0 || shippedProof || optOut !== null;

    return {
        ok,
        uiFiles,
        uncovered,
        run: [...run].sort(),
        coverage,
        changedScenarios,
        changedAuditFiles,
        optOut,
        message: ok ? null : refusalMessage(uncovered)
    };
}

/**
 * The refusal. It names the files, because "a UI surface changed" is not actionable, and it lists
 * every way out including the opt-out, because a gate whose only documented escape is "read the
 * source of the gate" gets deleted by the next person in a hurry.
 */
export function refusalMessage(uncovered) {
    return [
        'a UI surface changed and nothing exercises it against the real app.',
        '',
        '  changed UI files with no scenario covering them:',
        ...uncovered.map((file) => `    ${file}`),
        '',
        '  scripts/ui-audit/README.md ▸ The rule: a change to a UI surface ships with a scenario',
        '  (or an audit step) that presses it. A unit test pins the reducer; it does not press the',
        '  key. Do one of these:',
        '',
        '    1. write one, beside the change:   scripts/scenarios/<name>.mjs',
        '       then run it:                    node scripts/scenario.mjs --window hidden <name>',
        '    2. say an existing scenario already covers the file, in that scenario:',
        `       export const covers = ['${uncovered[0] ?? 'packages/client/src/...'}'];`,
        '    3. add a step to scripts/ui-audit/audit.mjs',
        '    4. opt out, on the record (printed here and written to the report):',
        '       node scripts/verify.mjs --no-scenario "why this cannot be exercised"'
    ].join('\n');
}

/** Frozen, pre-execution identities. Never infer the expected set from a result report. */
const list = value => Array.isArray(value) ? value : [];
const named = value => typeof value === 'string' && value.trim().length > 0;
export function inspectSelection(kind, report, selection) {
    const missing = [];
    if (selection?.kind !== kind || selection.complete !== true || typeof selection.ordered !== 'boolean' || !Array.isArray(selection.members) || !selection.members.length) return ['complete frozen selected-member plan absent'];
    const expected = selection.members;
    const members = kind === 'scenario' ? list(report?.summaries).map(s => ({ id: s?.name, entries: list(s?.results).map(a => a?.label) })) : kind === 'audit' ? list(report?.steps).map(s => ({ id: s?.id, entries: list(s?.assertions).map(a => a?.name), visual: s?.needsEyes })) : list(report?.testResults).map(s => ({ id: s?.name, entries: list(s?.assertionResults).map(a => Array.isArray(a?.ancestorTitles) && typeof a?.title === 'string' ? [...a.ancestorTitles, a.title].join(' > ') : a?.fullName ?? a?.title) }));
    if (new Set(expected.map(s => s?.id)).size !== expected.length || expected.some(s => !named(s?.id))) missing.push('invalid selected member identities');
    const ids = members.map(s => s.id), wanted = expected.map(s => s?.id);
    if (JSON.stringify(selection.ordered ? ids : [...ids].sort()) !== JSON.stringify(selection.ordered ? wanted : [...wanted].sort())) missing.push('selected member identities/order differ from frozen plan');
    for (const spec of expected) {
        if (!['assert', 'setup', 'visual'].includes(spec?.mode) || !Array.isArray(spec.requiredAssertions) || spec.requiredAssertions.some(n => !named(n)) || new Set(spec.requiredAssertions).size !== spec.requiredAssertions.length || !Number.isInteger(spec.minAssertions) || spec.minAssertions < (spec.mode === 'assert' ? 1 : 0) || (kind !== 'audit' && spec.mode !== 'assert')) { missing.push('invalid selected member assertion contract'); continue; }
        if (spec.mode === 'assert' && !spec.requiredAssertions.length && !spec.assertionPaths?.length || spec.complete === false || (spec.assertionPaths !== undefined && (!Array.isArray(spec.assertionPaths) || !spec.assertionPaths.length || spec.assertionPaths.some(p => !Array.isArray(p) || p.some(n => !named(n)) || spec.mode === 'assert' && !p.length))) || spec.requiredVisuals !== undefined && (!Array.isArray(spec.requiredVisuals) || spec.requiredVisuals.some(n => !named(n)))) { missing.push('incomplete selected member contract'); continue; }
        const actual = members.find(s => s.id === spec.id);
        if (!actual || actual.entries.length < spec.minAssertions || spec.requiredAssertions.some(n => !actual.entries.includes(n))) missing.push(`${spec.id}: required selected assertions absent`);
        if (spec.assertionPaths && !spec.assertionPaths.some(p => p.every(n => actual?.entries.includes(n)))) missing.push(`${spec.id}: complete successful assertion path absent`);
        if (!spec.requiredVisuals?.length && spec.mode === 'visual' && actual?.visual !== true) missing.push(`${spec.id}: visual-only step did not request review`);
    }
    if (kind === 'scenario' && expected.some(s => s?.file) && JSON.stringify(list(report?.files)) !== JSON.stringify(expected.map(s => s?.file))) missing.push('selected scenario files/order differ from frozen plan');
    const emitted = report?.expectedPlan ?? report?.meta?.expectedPlan ?? report?.selection ?? report?.meta?.selection;
    if (emitted && JSON.stringify(emitted) !== JSON.stringify(selection)) missing.push('runner selection differs from frozen plan');
    return missing;
}

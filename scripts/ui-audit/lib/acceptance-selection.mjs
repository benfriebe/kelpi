/** Frozen, pre-execution identities. Never infer the expected set from a result report. */
import { createHash } from 'node:crypto';
import { matchesAssertionSegments } from './assertion-declarations.mjs';
const list = value => Array.isArray(value) ? value : [];
const named = value => typeof value === 'string' && value.trim().length > 0;
/**
 * A display label is not an identity: parameterised Vitest cases and repeated audit probes are
 * allowed to share prose.  Freeze the occurrence as part of the selected-set identity instead
 * of silently collapsing either assertion.  The occurrence is local to its member, deterministic
 * in runner order, and deliberately visible in the report when a declaration is wrong.
 */
export const assertionIdentities = entries => {
    const counts = new Map();
    for (const name of list(entries)) {
        const label = String(name ?? '');
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const seen = new Map(), reserved = new Set(counts.keys()), used = new Set();
    return list(entries).map(name => {
        const label = String(name ?? '');
        const ordinal = (seen.get(label) ?? 0) + 1;
        seen.set(label, ordinal);
        let identity = counts.get(label) === 1 ? label : `${label} [${String(ordinal)}]`;
        if (counts.get(label) !== 1 && reserved.has(identity)) identity = `@assertion:${JSON.stringify([label, ordinal])}`;
        while (used.has(identity) || counts.get(label) !== 1 && reserved.has(identity)) identity = `@${identity}`;
        used.add(identity);
        return identity;
    });
};
export const assertionSetDigest = entries => createHash('sha256').update(JSON.stringify(assertionIdentities(entries))).digest('hex');
export function inspectSelection(kind, report, selection) {
    const missing = [];
    if (selection?.kind !== kind || selection.complete !== true || typeof selection.ordered !== 'boolean' || !Array.isArray(selection.members) || !selection.members.length) return ['complete frozen selected-member plan absent'];
    const expected = selection.members;
    const members = kind === 'smoke' ? [{ id: report?.name, entries: assertionIdentities(list(report?.assertions).map(a => a?.name)) }] : kind === 'scenario' ? list(report?.summaries).map(s => ({ id: s?.name, entries: assertionIdentities(list(s?.results).map(a => a?.label)) })) : kind === 'audit' ? list(report?.steps).map(s => ({ id: s?.id, entries: assertionIdentities(list(s?.assertions).map(a => a?.name)), visual: s?.needsEyes })) : list(report?.testResults).map(s => ({ id: s?.name, entries: assertionIdentities(list(s?.assertionResults).map(a => Array.isArray(a?.ancestorTitles) && typeof a?.title === 'string' ? [...a.ancestorTitles, a.title].join(' > ') : a?.fullName ?? a?.title)) }));
    if (new Set(expected.map(s => s?.id)).size !== expected.length || expected.some(s => !named(s?.id))) missing.push('invalid selected member identities');
    const ids = members.map(s => s.id), wanted = expected.map(s => s?.id);
    if (JSON.stringify(selection.ordered ? ids : [...ids].sort()) !== JSON.stringify(selection.ordered ? wanted : [...wanted].sort())) missing.push('selected member identities/order differ from frozen plan');
    for (const spec of expected) {
        if (!['assert', 'setup', 'visual'].includes(spec?.mode) || !Array.isArray(spec.requiredAssertions) || spec.requiredAssertions.some(n => !named(n)) || new Set(spec.requiredAssertions).size !== spec.requiredAssertions.length || !Number.isInteger(spec.minAssertions) || spec.minAssertions < (spec.mode === 'assert' ? 1 : 0) || (kind !== 'audit' && spec.mode !== 'assert')) { missing.push('invalid selected member assertion contract'); continue; }
        if (spec.mode === 'assert' && !spec.requiredAssertions.length && !spec.assertionPaths?.length && !spec.assertionPathSegments?.length || spec.complete === false || (spec.assertionPaths !== undefined && (!Array.isArray(spec.assertionPaths) || !spec.assertionPaths.length || spec.assertionPaths.some(p => !Array.isArray(p) || p.some(n => !named(n)) || spec.mode === 'assert' && !p.length))) || spec.requiredVisuals !== undefined && (!Array.isArray(spec.requiredVisuals) || spec.requiredVisuals.some(n => !named(n)))) { missing.push('incomplete selected member contract'); continue; }
        const actual = members.find(s => s.id === spec.id);
        if (typeof spec.expectedAssertionDigest === 'string' && assertionSetDigest(actual?.entries ?? []) !== spec.expectedAssertionDigest) missing.push(`${spec.id}: exact selected assertion identity set differs from frozen contract`);
        if (!actual || actual.entries.length < spec.minAssertions || spec.requiredAssertions.some(n => !actual.entries.includes(n))) missing.push(`${spec.id}: required selected assertions absent`);
        if (spec.assertionPathSegments !== undefined && !matchesAssertionSegments(spec.assertionPathSegments, actual?.entries)) missing.push(`${spec.id}: complete successful assertion segments absent`);
        if (spec.assertionPathSegments === undefined && spec.assertionPaths && !spec.assertionPaths.some(p => JSON.stringify(p) === JSON.stringify(actual?.entries))) missing.push(`${spec.id}: complete successful assertion path absent`);
        if (!spec.requiredVisuals?.length && spec.mode === 'visual' && actual?.visual !== true) missing.push(`${spec.id}: visual-only step did not request review`);
    }
    if (kind === 'scenario' && expected.some(s => s?.file) && JSON.stringify(list(report?.files)) !== JSON.stringify(expected.map(s => s?.file))) missing.push('selected scenario files/order differ from frozen plan');
    const emitted = report?.expectedPlan ?? report?.meta?.expectedPlan ?? report?.selection ?? report?.meta?.selection;
    if (emitted && JSON.stringify(emitted) !== JSON.stringify(selection)) missing.push('runner selection differs from frozen plan');
    return missing;
}

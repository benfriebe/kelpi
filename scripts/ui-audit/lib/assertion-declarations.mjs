/** Reviewed exceptions to static discovery, bound to the entire local harness import graph.
 * Inventories contain raw literal labels, in execution order, never result-derived digests.
 * Editing a source/helper requires reviewing and updating its binding; there is no refresh API.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve('vite/package.json', { paths: [path.resolve(import.meta.dirname, '../../../packages/client')] }));
const { parse } = viteRequire('acorn');
export const declarationFile = path.join(import.meta.dirname, 'assertion-declarations.json');
const limitations = new Set(['dynamic assertion name', 'dynamic assertion loop', 'dynamic assertion control flow', 'assertion or visual inside an unresolved callback']);
const named = value => typeof value === 'string' && value.trim().length > 0;
const relativeFile = value => named(value) && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const unique = values => new Set(values).size === values.length;
const scope = value => JSON.stringify([value.kind, value.source, value.id]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const subsequence = (shorter, longer) => { let offset = 0; for (const label of longer) if (label === shorter[offset]) offset++; return offset === shorter.length; };
const deletionAmbiguity = paths => paths.some((left, i) => Array.isArray(left) && paths.some((right, j) => i !== j && Array.isArray(right) && left.length <= right.length && subsequence(left, right)));

// A factored full-path inventory is a concatenation of one literal alternative per
// ordered segment. There are no wildcards, optional receipts, or result-derived counts.
// Labels must be unique across segments/within each alternative, so occurrence identities
// cannot depend on which geometric branch was selected in another segment.
function validSegments(segments) {
    if (!Array.isArray(segments) || !segments.length || segments.length > 128) return false;
    const earlier = new Set();
    for (const segment of segments) {
        if (!keys(segment, ['reason', 'alternatives']) || !named(segment.reason) || !Array.isArray(segment.alternatives) || !segment.alternatives.length || segment.alternatives.length > 128 || !unique(segment.alternatives.map(labels => JSON.stringify(labels)))) return false;
        // A shorter alternative must not be obtainable by deleting receipts from a longer
        // one. Branch/cardinality receipts distinguish legitimate shorter successful paths.
        if (deletionAmbiguity(segment.alternatives)) return false;
        const current = new Set();
        for (const labels of segment.alternatives) {
            if (!Array.isArray(labels) || !labels.length || labels.some(label => !named(label) || earlier.has(label)) || !unique(labels)) return false;
            labels.forEach(label => current.add(label));
        }
        current.forEach(label => earlier.add(label));
    }
    return true;
}
export function matchesAssertionSegments(segments, entries) {
    if (!validSegments(segments) || !Array.isArray(entries) || entries.some(label => !named(label))) return false;
    let offsets = new Set([0]);
    for (const segment of segments) {
        const next = new Set();
        for (const offset of offsets) for (const alternative of segment.alternatives) {
            if (alternative.every((label, index) => entries[offset + index] === label)) next.add(offset + alternative.length);
        }
        if (!next.size) return false;
        offsets = next;
    }
    return offsets.has(entries.length);
}
const segmentRequired = segments => segments.flatMap(segment => segment.alternatives[0].filter(label => segment.alternatives.every(labels => labels.includes(label))));

export function validateDeclarations(document) {
    const errors = [];
    if (!keys(document, ['schemaVersion', 'bindings', 'members']) || document.schemaVersion !== 1 || !record(document.bindings) || !Array.isArray(document.members) || !document.members.length) return ['invalid assertion declaration document'];
    if (!Object.keys(document.bindings).length || Object.entries(document.bindings).some(([file, sha256]) => !relativeFile(file) || !digest(sha256))) errors.push('invalid assertion declaration byte bindings');
    const seen = new Set();
    for (const member of document.members) {
        if (!keys(member, ['kind', 'id', 'source', 'dependencies', 'limitations', 'paths', 'requiredVisuals', 'review', ...(member?.pathSegments === undefined ? [] : ['pathSegments'])]) || !['scenario', 'audit', 'smoke'].includes(member.kind) || !named(member.id) || !relativeFile(member.source) || !named(member.review)) { errors.push('invalid assertion declaration member'); continue; }
        if (seen.has(scope(member))) errors.push(`duplicate assertion declaration scope: ${scope(member)}`);
        seen.add(scope(member));
        if (!Array.isArray(member.dependencies) || !member.dependencies.includes(member.source) || !unique(member.dependencies) || member.dependencies.some(file => !relativeFile(file) || !digest(document.bindings[file]))) errors.push(`${member.id}: invalid dependency bindings`);
        if (!Array.isArray(member.limitations) || !unique(member.limitations.map(item => item?.error)) || member.limitations.some(item => !keys(item, ['error', 'reason']) || !limitations.has(item.error) || !named(item.reason))) errors.push(`${member.id}: invalid reviewed parser limitations`);
        if (!Array.isArray(member.paths) || !member.paths.length || !unique(member.paths.map(item => JSON.stringify(item?.assertions))) || deletionAmbiguity(member.paths.map(item => item?.assertions)) || member.paths.some(item => !keys(item, ['reason', 'count', 'assertions']) || !named(item.reason) || !Array.isArray(item.assertions) || !item.assertions.length || item.assertions.some(label => !named(label)) || !Number.isSafeInteger(item.count) || item.count !== item.assertions.length)) errors.push(`${member.id}: invalid literal assertion paths/count`);
        if (member.pathSegments !== undefined) {
            if (!validSegments(member.pathSegments) || !Array.isArray(member.paths) || member.paths.length !== 1 || JSON.stringify(member.paths[0]?.assertions) !== JSON.stringify(member.pathSegments.flatMap(segment => segment.alternatives[0]))) errors.push(`${member.id}: invalid explicit path segments`);
        }
        if (!Array.isArray(member.requiredVisuals) || !unique(member.requiredVisuals) || member.requiredVisuals.some(id => !named(id) || (member.kind === 'audit' ? id !== member.id : !id.startsWith(`${member.id}:shot:`)))) errors.push(`${member.id}: invalid visual obligations`);
    }
    return errors;
}

const children = node => Object.values(node ?? {}).flatMap(value => Array.isArray(value) ? value : [value]).filter(value => value && typeof value.type === 'string');
const walk = (node, visit) => { visit(node); for (const child of children(node)) walk(child, visit); };
const within = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
function sourceFile(root, relative) {
    if (!relativeFile(relative)) throw new Error(`invalid bound source path: ${relative}`);
    const file = path.resolve(root, relative);
    if (!within(fs.realpathSync(root), fs.realpathSync(file))) throw new Error(`bound source escapes harness root: ${relative}`);
    return file;
}
/** Include both normal and literal dynamic imports, export-from helpers, and lockfile bytes.
 * Entry points bind injected recorder/driver helpers as well as a scenario's own imports.
 * All branches are traversed without executing any code or importing a scenario.
 */
export function declarationDependencies(root, kind, source) {
    const pending = [source, 'package.json', 'pnpm-lock.yaml'];
    if (kind === 'scenario') pending.push('scripts/scenario.mjs', 'scripts/ui-audit/lib/driver.mjs', 'scripts/ui-audit/lib/placement.mjs');
    // These fixtures are opened by path (not imported): bind the actual helper bytes too.
    if (kind === 'scenario' || kind === 'audit') {
        for (const directory of ['scripts/fixtures', 'scripts/ui-audit/fixtures']) {
            const files = fs.readdirSync(path.join(root, directory), {recursive:true});
            for (const file of files) if (fs.statSync(path.join(root, directory, file)).isFile()) pending.push(`${directory}/${file.split(path.sep).join('/')}`);
        }
    }
    if (kind === 'smoke' && source.endsWith('/packaged-smoke.mjs')) pending.push('packages/shell/src/packaging.ts');
    const found = new Set();
    while (pending.length) {
        const relative = pending.pop();
        if (found.has(relative)) continue;
        const file = sourceFile(root, relative);
        found.add(relative);
        if (!/\.[cm]?js$/.test(file)) continue;
        const parsed = parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
        walk(parsed, node => {
            const specifier = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) ? node.source?.value : undefined;
            if (typeof specifier === 'string' && specifier.startsWith('.')) pending.push(path.relative(root, path.resolve(path.dirname(file), specifier)).split(path.sep).join('/'));
        });
    }
    return [...found].sort();
}

/** One reader per plan call: byte hashes are shared within a plan, never across discoveries. */
export function declarationReader(root, document) {
    let schemaErrors;
    try { document ??= JSON.parse(fs.readFileSync(declarationFile, 'utf8')); schemaErrors = validateDeclarations(document); }
    catch (error) { schemaErrors = [`cannot read assertion declarations: ${error.message}`]; }
    const hashes = new Map(), dependencyLists = new Map();
    const bytes = file => {
        if (!hashes.has(file)) hashes.set(file, hash(fs.readFileSync(sourceFile(root, file))));
        return hashes.get(file);
    };
    return (kind, file, selected) => {
        const fail = errors => ({ ...selected, complete: false, contractErrors: [...new Set([...selected.contractErrors, ...errors])] });
        if (schemaErrors.length) return fail(schemaErrors);
        const source = path.relative(root, path.resolve(file)).split(path.sep).join('/');
        const member = document.members.find(item => scope(item) === scope({kind, source, id:selected.id}));
        if (!member) {
            // A known identity cannot borrow its declaration from another file or namespace.
            if (document.members.some(item => item.kind === kind && item.id === selected.id)) return fail(['reviewed assertion source path differs']);
            return selected;
        }
        const errors = [];
        try {
            const dependencyKey = JSON.stringify([kind, source]);
            if (!dependencyLists.has(dependencyKey)) dependencyLists.set(dependencyKey, declarationDependencies(root, kind, source));
            if (JSON.stringify([...member.dependencies].sort()) !== JSON.stringify(dependencyLists.get(dependencyKey))) errors.push('reviewed assertion dependency graph differs');
            for (const dependency of member.dependencies) if (bytes(dependency) !== document.bindings[dependency]) errors.push(`reviewed assertion source/helper bytes differ: ${dependency}`);
        } catch (error) { errors.push(`cannot verify reviewed assertion source: ${error.message}`); }
        if (errors.length) return fail(errors);
        const approved = new Set(member.limitations.map(item => item.error));
        const remaining = selected.contractErrors.filter(error => !approved.has(error));
        // A declaration may fill parser blind spots, but cannot remove any proven mandatory
        // assertion (including cleanup) or any discovered visual review obligation.
        for (const candidate of member.pathSegments ? [{assertions:segmentRequired(member.pathSegments)}] : member.paths) {
            const required = [...selected.requiredAssertions];
            for (const label of candidate.assertions) if (label === required[0]) required.shift();
            if (required.length) remaining.push('reviewed assertion path omits statically required assertions');
        }
        if (selected.requiredVisuals.some(id => !member.requiredVisuals.includes(id))) remaining.push('reviewed assertion declaration omits visual obligations');
        if (remaining.length) return fail(remaining);
        const assertionPaths = member.paths.map(item => [...item.assertions]);
        return { ...selected, mode: 'assert', complete: true, contractErrors: [],
            reviewedContract: { schemaVersion: 1, source, sourceSha256: document.bindings[source], dependencies: Object.fromEntries(member.dependencies.map(file => [file, document.bindings[file]])), review: member.review },
            parserLimitations: member.limitations,
            ...(member.pathSegments ? {assertionPathSegments:structuredClone(member.pathSegments)} : {}),
            assertionPaths, requiredAssertions: member.pathSegments ? segmentRequired(member.pathSegments) : assertionPaths[0].filter(label => assertionPaths.every(labels => labels.includes(label))),
            minAssertions: member.pathSegments ? member.pathSegments.reduce((sum,segment)=>sum+Math.min(...segment.alternatives.map(labels=>labels.length)),0) : Math.min(...assertionPaths.map(labels => labels.length)), requiredVisuals: [...member.requiredVisuals] };
    };
}

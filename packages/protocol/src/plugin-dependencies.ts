import type { PluginDependency, PluginManifest } from './plugins.js';

type Version = { core: [number, number, number]; pre: string[] };

function parseVersion(input: string): Version | null {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(input);
    if (!match) return null;
    const core: Version['core'] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const pre = match[4]?.split('.') ?? [];
    if (core.some(n => !Number.isSafeInteger(n)) || pre.some(part => /^0\d+$/.test(part))) return null;
    return { core, pre };
}

export function isPluginVersion(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 200 && parseVersion(value) !== null;
}

/** Deliberately bounded range syntax; unsupported ranges are rejected, never guessed. */
export function isPluginVersionRange(value: unknown): value is string {
    return typeof value === 'string' && (value === '*' || isPluginVersion(value.replace(/^[\^~]/, '')));
}

function compare(a: Version, b: Version): number {
    for (let index = 0; index < 3; index++) {
        const difference = a.core[index]! - b.core[index]!;
        if (difference !== 0) return difference;
    }
    if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
    for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
        const left = a.pre[index], right = b.pre[index];
        if (left === undefined) return -1;
        if (right === undefined) return 1;
        if (left === right) continue;
        const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
        if (leftNumeric && rightNumeric) return left.length - right.length || (left < right ? -1 : 1);
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return left < right ? -1 : 1;
    }
    return 0;
}

export function pluginVersionMatches(version: string, range: string): boolean {
    const candidate = parseVersion(version);
    if (!candidate || !isPluginVersionRange(range)) return false;
    if (range === '*') return candidate.pre.length === 0;
    const operator = range[0] === '^' || range[0] === '~' ? range[0] : '';
    const minimum = parseVersion(operator ? range.slice(1) : range)!;
    if (!operator) return compare(candidate, minimum) === 0;
    // Prereleases are opt-in and only match the specified release's prerelease series.
    if (candidate.pre.length && (!minimum.pre.length || candidate.core.some((n, index) => n !== minimum.core[index]))) return false;
    const [major, minor, patch] = minimum.core;
    const upper: Version = { core: operator === '~' ? [major, minor + 1, 0]
        : major > 0 ? [major + 1, 0, 0] : minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1], pre: [] };
    return compare(candidate, minimum) >= 0 && compare(candidate, upper) < 0;
}

export interface PluginDependencyInstallation {
    readonly manifest: PluginManifest;
    readonly enabled: boolean;
    readonly status?: string;
    readonly error?: string | null;
}

function available(dependency: PluginDependency, records: ReadonlyMap<string, PluginDependencyInstallation>): PluginDependencyInstallation | undefined {
    const record = records.get(dependency.pluginID);
    return record?.enabled && record.status !== 'failed' && pluginVersionMatches(record.manifest.version, dependency.version) ? record : undefined;
}

/** Returns the first actionable dependency failure, including transitive failures/cycles. */
export function pluginDependencyProblem(id: string, installed: readonly PluginDependencyInstallation[]): string | null {
    const records = new Map(installed.map(record => [record.manifest.id, record]));
    const complete = new Set<string>();
    const visit = (pluginID: string, trail: readonly string[]): string | null => {
        if (trail.includes(pluginID)) return `plugin dependency cycle: ${[...trail, pluginID].join(' → ')}`;
        if (complete.has(pluginID)) return null;
        const record = records.get(pluginID);
        if (!record) return `missing plugin dependency: ${pluginID}`;
        for (const dependency of record.manifest.dependencies ?? []) {
            const resolved = available(dependency, records);
            if (!resolved) {
                if (dependency.optional) continue;
                const current = records.get(dependency.pluginID);
                const reason = !current ? 'not installed' : !current.enabled ? 'disabled' : current.status === 'failed' ? `failed${current.error ? `: ${current.error}` : ''}` : `installed version ${current.manifest.version} is incompatible`;
                return `${pluginID} requires ${dependency.pluginID} ${dependency.version} (${reason})`;
            }
            const problem = visit(resolved.manifest.id, [...trail, pluginID]);
            // An optional plugin whose own prerequisites are unavailable is unavailable too.
            // A present cycle remains an invalid graph, rather than an activation deadlock.
            if (problem && (!dependency.optional || problem.startsWith('plugin dependency cycle:'))) return problem;
        }
        complete.add(pluginID);
        return null;
    };
    return visit(id, []);
}

/** Dependency-first activation order for the requested roots. Never mutates the input. */
export function pluginDependencyOrder(manifests: readonly PluginManifest[], roots: readonly string[] = manifests.map(manifest => manifest.id)): PluginManifest[] {
    const records = new Map(manifests.map(manifest => [manifest.id, manifest]));
    if (records.size !== manifests.length) throw new Error('duplicate plugin identity');
    const installations = manifests.map(manifest => ({ manifest, enabled: true }));
    const result: PluginManifest[] = [];
    const visited = new Set<string>();
    const visit = (id: string): void => {
        if (visited.has(id)) return;
        const manifest = records.get(id);
        if (!manifest) throw new Error(`missing plugin dependency: ${id}`);
        visited.add(id);
        for (const dependency of manifest.dependencies ?? []) {
            const found = records.get(dependency.pluginID);
            if (found && pluginVersionMatches(found.version, dependency.version) && (!dependency.optional || pluginDependencyProblem(found.id, installations) === null)) visit(found.id);
        }
        result.push(manifest);
    };
    for (const id of roots) {
        const problem = pluginDependencyProblem(id, installations);
        if (problem) throw new Error(problem);
        visit(id);
    }
    return result;
}

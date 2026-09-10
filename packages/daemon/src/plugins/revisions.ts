import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PluginPackageFile } from '@kelpi/core/plugin-package';
import { decodePluginManifest, isPluginID, PLUGIN_MAX_JSON_BYTES, pluginObject, pluginRecord, type JsonObject, type JsonValue, type PluginManifest } from '@kelpi/protocol';

export const PLUGIN_RETAINED_REVISIONS = 100;
export interface InstalledRevision { readonly manifest: PluginManifest; readonly revision: string; readonly installedAt: number | null }
export interface PluginInstallation { readonly manifest: PluginManifest; readonly revision: string; readonly enabled: boolean; readonly revisions: readonly InstalledRevision[]; readonly selectionID: string | null }
const isRevision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isSelection = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

export function decodePluginInstallation(raw: unknown): PluginInstallation {
    if (!pluginRecord(raw) || !isRevision(raw['revision'])) throw new Error('invalid installed plugin');
    const manifest = decodePluginManifest(raw['manifest']);
    if (raw['selectionID'] !== undefined && raw['selectionID'] !== null && !isSelection(raw['selectionID'])) throw new Error('invalid plugin revision selection');
    const history = raw['revisions'];
    const revisions: InstalledRevision[] = [];
    if (history === undefined) revisions.push({ manifest, revision: raw['revision'], installedAt: null });
    else {
        if (!Array.isArray(history) || !history.length || history.length > PLUGIN_RETAINED_REVISIONS) throw new Error('invalid plugin revision history');
        for (const row of history) {
            if (!pluginRecord(row) || !isRevision(row['revision']) || (row['installedAt'] !== null && (!Number.isSafeInteger(row['installedAt']) || Number(row['installedAt']) < 0))) throw new Error('invalid plugin revision record');
            const recorded = decodePluginManifest(row['manifest']);
            if (recorded.id !== manifest.id || revisions.some(item => item.revision === row['revision'])) throw new Error('invalid plugin revision identity');
            revisions.push({ manifest: recorded, revision: row['revision'], installedAt: row['installedAt'] as number | null });
        }
        if (revisions[0]?.revision !== raw['revision'] || JSON.stringify(revisions[0].manifest) !== JSON.stringify(manifest)) throw new Error('selected plugin revision does not match history');
    }
    return { manifest, revision: raw['revision'], enabled: raw['enabled'] === true, revisions, selectionID: raw['selectionID'] as string | null | undefined ?? null };
}

export function selectPluginRevision(previous: PluginInstallation | undefined, manifest: PluginManifest, revision: string, enabled: boolean): PluginInstallation {
    const selected = previous?.revisions.find(item => item.revision === revision) ?? { manifest, revision, installedAt: Date.now() };
    return { manifest, revision, enabled, revisions: [selected, ...previous?.revisions.filter(item => item.revision !== revision) ?? []].slice(0, PLUGIN_RETAINED_REVISIONS), selectionID: randomUUID() };
}

/** The pre-package installer hashed a depth-first, locale-sorted tree, not byte-sorted paths. */
export function legacyPluginRevision(files: readonly PluginPackageFile[]): string {
    const ordered = [...files].sort((a, b) => {
        const left = a.relative.split('/'), right = b.relative.split('/');
        for (let i = 0; i < Math.min(left.length, right.length); i++) {
            const result = left[i]!.localeCompare(right[i]!); if (result) return result;
        }
        return left.length - right.length;
    });
    const hash = createHash('sha256');
    for (const file of ordered) hash.update(file.relative).update('\0').update(String(file.bytes.length)).update('\0').update(file.bytes);
    return hash.digest('hex');
}

type DataKind = 'storage' | 'settings';
const dataKinds: readonly DataKind[] = ['storage', 'settings'];
const journalName = 'revision-change.json';
const dataPath = (directory: string, id: string, kind: DataKind): string => path.join(directory, 'data', id, `${kind}.json`);
function writeJSON(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    let published = false;
    try { fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, file); published = true; }
    finally { if (!published) fs.rmSync(temporary, { force: true }); }
}
function restoreData(directory: string, id: string, files: Readonly<Record<string, string | null>>): void {
    for (const [kind, bytes] of Object.entries(files)) {
        const target = dataPath(directory, id, kind as DataKind);
        if (bytes === null) fs.rmSync(target, { force: true });
        else {
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            const temporary = `${target}.${randomUUID()}.tmp`;
            let published = false;
            try { fs.writeFileSync(temporary, Buffer.from(bytes, 'base64'), { mode: 0o600 }); fs.renameSync(temporary, target); published = true; }
            finally { if (!published) fs.rmSync(temporary, { force: true }); }
        }
    }
}

/** Resolve an interrupted owned-data flush before any backend starts. Unknown/corrupt journals remain untouched. */
export function recoverPluginRevisionChange(directory: string, installed: ReadonlyMap<string, PluginInstallation>): void {
    const journal = path.join(directory, journalName);
    let raw: unknown;
    try {
        if (fs.statSync(journal).size > 2 * PLUGIN_MAX_JSON_BYTES * 2 + 4096) throw new Error('plugin revision journal exceeds its limit');
        raw = JSON.parse(fs.readFileSync(journal, 'utf8'));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!pluginRecord(raw) || raw['version'] !== 1 || !isPluginID(raw['pluginID']) || !isRevision(raw['previousRevision']) || !isRevision(raw['nextRevision']) ||
        (raw['previousSelectionID'] !== null && !isSelection(raw['previousSelectionID'])) || !isSelection(raw['nextSelectionID']) || !pluginRecord(raw['files'])) throw new Error('invalid plugin revision journal');
    const entries = Object.entries(raw['files']);
    if (entries.length > dataKinds.length) throw new Error('invalid plugin revision journal files');
    const files: Record<string, string | null> = {};
    for (const [kind, encoded] of entries) {
        if (!dataKinds.includes(kind as DataKind) || (encoded !== null && typeof encoded !== 'string')) throw new Error('invalid plugin revision journal data');
        if (typeof encoded === 'string') {
            const bytes = Buffer.from(encoded, 'base64');
            if (bytes.length > PLUGIN_MAX_JSON_BYTES || bytes.toString('base64') !== encoded) throw new Error('invalid plugin revision journal bytes');
            pluginObject(JSON.parse(bytes.toString('utf8')));
        }
        files[kind] = encoded;
    }
    const selected = installed.get(raw['pluginID']);
    if (selected?.revision === raw['previousRevision'] && selected.selectionID === raw['previousSelectionID']) restoreData(directory, raw['pluginID'], files);
    else if (selected?.revision !== raw['nextRevision'] || selected.selectionID !== raw['nextSelectionID']) throw new Error('plugin revision journal does not match the selected installation');
    fs.rmSync(journal);
}

/** Candidate activation sees its own JSON writes; old code remains recoverable until the registry commits. */
export class PluginRevisionData {
    private readonly values = new Map<DataKind, JsonObject>();
    private pending = false;
    readonly settings = new Map<string, JsonValue>();
    constructor(private readonly directory: string, private readonly pluginID: string, private readonly previousRevision: string, private readonly nextRevision: string,
        private readonly previousSelectionID: string | null, private readonly nextSelectionID: string) {}
    read(kind: string): JsonObject | undefined { return this.values.get(kind as DataKind); }
    get recoveryPending(): boolean { return this.pending; }
    write(kind: DataKind, value: JsonObject): void { this.values.set(kind, pluginObject(value)); }
    commit(persist: () => void): void {
        if (!this.values.size) { persist(); return; }
        const files: Record<string, string | null> = {};
        for (const kind of this.values.keys()) {
            try {
                const file = dataPath(this.directory, this.pluginID, kind);
                if (fs.statSync(file).size > PLUGIN_MAX_JSON_BYTES) throw new Error('plugin data exceeds 256 KiB');
                const bytes = fs.readFileSync(file); pluginObject(JSON.parse(bytes.toString('utf8')));
                files[kind] = bytes.toString('base64');
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; files[kind] = null; }
        }
        const journal = path.join(this.directory, journalName);
        writeJSON(journal, { version: 1, pluginID: this.pluginID, previousRevision: this.previousRevision, nextRevision: this.nextRevision,
            previousSelectionID: this.previousSelectionID, nextSelectionID: this.nextSelectionID, files });
        this.pending = true;
        try {
            for (const [kind, value] of this.values) writeJSON(dataPath(this.directory, this.pluginID, kind), value);
            persist();
        } catch (error) {
            restoreData(this.directory, this.pluginID, files);
            fs.rmSync(journal, { force: true });
            this.pending = false;
            throw error;
        }
        // A remaining journal is safe: the next boot sees the committed revision and keeps its data.
        try { fs.rmSync(journal, { force: true }); this.pending = false; } catch { /* recovered before the next mutation or daemon start */ }
    }
}

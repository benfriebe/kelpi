/** Node-only package IO, shared by offline author tools and the daemon installer. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { decodePluginManifest, pluginAssetPath, pluginRecord, type PluginManifest } from '@kelpi/protocol';

export const PLUGIN_PACKAGE_MAX_BYTES = 32 * 1024 * 1024;
export const PLUGIN_PACKAGE_MAX_FILES = 2000;
// Base64 data plus bounded paths/JSON overhead. Also bounds compressed input and inflation.
const maxArchiveBytes = 48 * 1024 * 1024;
const compress = promisify(gzip), decompress = promisify(gunzip);
export interface PluginPackageFile { readonly relative: string; readonly bytes: Buffer }
export interface PluginPackage {
    readonly manifest: PluginManifest;
    readonly revision: string;
    readonly files: readonly PluginPackageFile[];
    readonly totalBytes: number;
    readonly format: 'directory' | 'kelpi-plugin';
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const excluded = (name: string): boolean => name === '.git' || name === 'node_modules';

/** Validate names for supported filesystems before hashing or extracting them. */
function portablePath(relative: unknown): string {
    const name = pluginAssetPath(relative);
    // Apply the protocol's 512-character budget in UTF-8 bytes too, leaving room
    // for the installer prefix within macOS's 1024-byte filesystem path limit.
    if (Buffer.byteLength(name) > 512) throw new Error(`plugin path exceeds 512 UTF-8 bytes: ${name}`);
    // JSON permits unpaired surrogates; Node replaces them when opening a path. Reject
    // them before hashing so distinct archive names can never address the same file.
    if (Buffer.from(name).toString('utf8') !== name || /[\x00-\x1f\x7f<>"|*]/.test(name) || name.split('/').some(part =>
        Buffer.byteLength(part) > 255 || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part) || excluded(part.toLowerCase()))) {
        throw new Error(`non-portable plugin path: ${name}`);
    }
    return name;
}

function validateFiles(files: PluginPackageFile[], format: PluginPackage['format']): PluginPackage {
    if (files.length > PLUGIN_PACKAGE_MAX_FILES) throw new Error('plugin package has too many files');
    let totalBytes = 0, directories = 0;
    const paths = new Map<string, { name: string; directory: boolean }>();
    for (const file of files) {
        const parts = portablePath(file.relative).split('/');
        for (let i = 1; i <= parts.length; i++) {
            const name = parts.slice(0, i).join('/');
            // Fold both directions to include aliases such as Greek final sigma and
            // long s, which a lowercase-only comparison misses on case-folding volumes.
            const key = name.normalize('NFC').toLowerCase().toUpperCase().normalize('NFC');
            const directory = i < parts.length, previous = paths.get(key);
            if (previous && (previous.name !== name || !previous.directory || !directory)) throw new Error(`conflicting plugin paths: ${previous.name} and ${file.relative}`);
            if (!previous && directory && ++directories > PLUGIN_PACKAGE_MAX_FILES) throw new Error('plugin package has too many directories');
            paths.set(key, { name, directory });
        }
        totalBytes += file.bytes.length;
        if (totalBytes > PLUGIN_PACKAGE_MAX_BYTES) throw new Error('plugin package exceeds 32 MiB');
    }
    // Explicit byte order, independent of locale, source traversal order and filesystem metadata.
    files.sort((a, b) => Buffer.compare(Buffer.from(a.relative), Buffer.from(b.relative)));
    const manifestFile = files.find(file => file.relative === 'kelpi.plugin.json');
    if (!manifestFile) throw new Error('missing kelpi.plugin.json');
    const manifest = decodePluginManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestFile.bytes)));
    for (const entry of [...manifest.contributes.views.map(view => view.entry), ...(manifest.backend ? [manifest.backend] : [])]) {
        if (!files.some(file => file.relative === entry)) throw new Error(`missing plugin entry: ${entry}`);
    }
    const hash = createHash('sha256');
    for (const file of files) hash.update(file.relative).update('\0').update(String(file.bytes.length)).update('\0').update(file.bytes);
    return { manifest, revision: hash.digest('hex'), files, totalBytes, format };
}

/** Bound reads even if a regular file grows after stat; never follow a final symlink. */
async function readBounded(file: string, limit: number, message: string): Promise<Buffer> {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error(`unsupported plugin file: ${file}`);
        if (stat.size > limit) throw new Error(message);
        const chunks: Buffer[] = [];
        let total = 0;
        for (;;) {
            const chunk = Buffer.alloc(Math.min(64 * 1024, limit - total + 1));
            const { bytesRead } = await handle.read(chunk);
            if (!bytesRead) return Buffer.concat(chunks, total);
            total += bytesRead;
            if (total > limit) throw new Error(message);
            chunks.push(chunk.subarray(0, bytesRead));
        }
    } finally { await handle.close(); }
}

async function readDirectory(root: string): Promise<PluginPackage> {
    const files: PluginPackageFile[] = [];
    let total = 0, directories = 0;
    const scan = async (relative: string): Promise<void> => {
        const directory = path.join(root, relative);
        if (await fs.realpath(directory) !== directory) throw new Error(`plugin packages cannot contain symlinks: ${relative}`);
        for await (const entry of await fs.opendir(directory)) {
            if (excluded(entry.name)) continue;
            const name = portablePath(relative ? `${relative}/${entry.name}` : entry.name);
            if (entry.isSymbolicLink()) throw new Error(`plugin packages cannot contain symlinks: ${name}`);
            if (entry.isDirectory()) {
                if (++directories > PLUGIN_PACKAGE_MAX_FILES) throw new Error('plugin package has too many directories');
                await scan(name); continue;
            }
            if (!entry.isFile()) throw new Error(`unsupported plugin file: ${name}`);
            if (files.length >= PLUGIN_PACKAGE_MAX_FILES) throw new Error('plugin package has too many files');
            const file = path.join(root, name);
            if (await fs.realpath(file) !== file) throw new Error(`plugin packages cannot contain symlinks: ${name}`);
            const bytes = await readBounded(file, PLUGIN_PACKAGE_MAX_BYTES - total, 'plugin package exceeds 32 MiB');
            if (await fs.realpath(file) !== file) throw new Error(`plugin packages cannot contain symlinks: ${name}`);
            total += bytes.length; files.push({ relative: name, bytes });
        }
    };
    await scan('');
    return validateFiles(files, 'directory');
}

/** A .kelpi-plugin is gzip-compressed JSON, never an executable or a general-purpose archive. */
async function readArchive(file: string): Promise<PluginPackage> {
    const bytes = await readBounded(file, maxArchiveBytes, 'plugin archive exceeds 48 MiB');
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await decompress(bytes, { maxOutputLength: maxArchiveBytes })));
    } catch { throw new Error('invalid plugin archive (expected bounded gzip-compressed package JSON)'); }
    if (!pluginRecord(raw) || raw['format'] !== 'kelpi-plugin' || raw['formatVersion'] !== 1) throw new Error('unsupported plugin package format (expected kelpi-plugin version 1)');
    if (typeof raw['revision'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['revision'])) throw new Error('invalid plugin package revision');
    const entries = raw['files'];
    if (!Array.isArray(entries) || entries.length > PLUGIN_PACKAGE_MAX_FILES) throw new Error('plugin package has too many files or invalid file list');
    let total = 0;
    const files = entries.map((entry): PluginPackageFile => {
        if (!pluginRecord(entry) || typeof entry['data'] !== 'string') throw new Error('invalid plugin package file');
        const relative = portablePath(entry['path']);
        if (entry['data'].length > Math.ceil((PLUGIN_PACKAGE_MAX_BYTES - total) / 3) * 4) throw new Error('plugin package exceeds 32 MiB');
        const bytes = Buffer.from(entry['data'], 'base64');
        if (bytes.toString('base64') !== entry['data']) throw new Error(`invalid base64 plugin file: ${relative}`);
        total += bytes.length;
        if (total > PLUGIN_PACKAGE_MAX_BYTES) throw new Error('plugin package exceeds 32 MiB');
        return { relative, bytes };
    });
    const result = validateFiles(files, 'kelpi-plugin');
    if (result.revision !== raw['revision']) throw new Error('plugin package revision mismatch');
    return result;
}

/** Validates/captures exact bytes without importing or running plugin code. */
export async function readPluginPackage(source: string): Promise<PluginPackage> {
    const root = await fs.realpath(source), stat = await fs.stat(root);
    if (stat.isDirectory()) return readDirectory(root);
    if (stat.isFile()) return readArchive(root);
    throw new Error('plugin source must be a directory or .kelpi-plugin file');
}

export function pluginPackageReport(pkg: PluginPackage) {
    return {
        format: pkg.format, pluginID: pkg.manifest.id, name: pkg.manifest.name, version: pkg.manifest.version,
        apiVersion: pkg.manifest.apiVersion, revision: pkg.revision, fileCount: pkg.files.length, totalBytes: pkg.totalBytes,
        dependencies: pkg.manifest.dependencies ?? [],
        files: pkg.files.map(file => ({ path: file.relative, bytes: file.bytes.length, sha256: digest(file.bytes) })),
    };
}

/** Atomically publishes a deterministic artifact without overwriting a file or packaging itself. */
export async function packPlugin(source: string, output: string) {
    const root = await fs.realpath(source);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('pack requires a plugin directory');
    const destination = path.join(await fs.realpath(path.dirname(path.resolve(output))), path.basename(output));
    if (destination === root || destination.startsWith(root + path.sep)) throw new Error('plugin package output must be outside the source directory');
    const pkg = await readDirectory(root);
    const document = JSON.stringify({ format: 'kelpi-plugin', formatVersion: 1, revision: pkg.revision,
        files: pkg.files.map(file => ({ path: file.relative, data: file.bytes.toString('base64') })) });
    const bytes = await compress(Buffer.from(document), { level: 9 });
    const temporary = path.join(path.dirname(destination), `.kelpi-package-${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await fs.link(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }); }
    return { ...pluginPackageReport({ ...pkg, format: 'kelpi-plugin' }), path: destination, archiveBytes: bytes.length, sha256: digest(bytes) };
}

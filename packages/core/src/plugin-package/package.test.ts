import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { packPlugin, pluginPackageReport, readPluginPackage, PLUGIN_PACKAGE_MAX_BYTES } from './index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-package-')); roots.push(root);
    const source = path.join(root, 'source'); fs.mkdirSync(path.join(source, 'ui'), { recursive: true });
    const manifest = { id: 'example.package', name: 'Package', version: '1.2.3', apiVersion: 1, trust: 'full', backend: 'backend.mjs',
        dependencies: [{ pluginID: 'example.other', version: '^1.0.0', optional: true }],
        contributes: { views: [{ id: 'example.package.view', title: 'View', entry: 'ui/index.html', placements: ['pane'] }] } };
    fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(source, 'backend.mjs'), 'throw new Error("validation must never execute me");');
    fs.writeFileSync(path.join(source, 'ui/index.html'), '<h1>Package</h1>');
    const archive = path.join(root, 'test.kelpi-plugin');
    const writeArchive = (value: unknown) => fs.writeFileSync(archive, gzipSync(JSON.stringify(value)));
    return { root, source, manifest, archive, writeArchive };
}
const envelope = (files: unknown[]) => ({ format: 'kelpi-plugin', formatVersion: 1, revision: '0'.repeat(64), files });
const member = (name: string, data = '') => ({ path: name, data });

describe('shared plugin packaging', () => {
    it('round-trips exact bytes, reports declared compatibility and excludes dependency/check-out directories', async () => {
        const h = fixture();
        for (const directory of ['.git', 'node_modules']) {
            fs.mkdirSync(path.join(h.source, directory)); fs.symlinkSync('/missing', path.join(h.source, directory, 'ignored'));
        }
        fs.writeFileSync(path.join(h.source, 'ui/binary'), Buffer.from([0, 255, 128, 13, 10]));
        const original = await readPluginPackage(h.source), report = await packPlugin(h.source, h.archive);
        fs.writeFileSync(path.join(h.source, 'backend.mjs'), 'changed');
        const packed = await readPluginPackage(h.archive);
        expect(packed).toEqual({ ...original, format: 'kelpi-plugin' });
        expect(report).toMatchObject({ pluginID: 'example.package', version: '1.2.3', apiVersion: 1, fileCount: 4, revision: original.revision });
        expect(report.dependencies).toEqual(h.manifest.dependencies);
        expect(report.files.map(file => file.path)).toEqual(['backend.mjs', 'kelpi.plugin.json', 'ui/binary', 'ui/index.html']);
        expect(report.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
        expect(pluginPackageReport(packed).totalBytes).toBe(original.files.reduce((sum, file) => sum + file.bytes.length, 0));
    });
    it('produces identical archives despite timestamps, creation order, modes and source location', async () => {
        const a = fixture(), b = fixture();
        for (const name of ['z', 'A', 'a-b', 'a.b', 'é']) fs.writeFileSync(path.join(a.source, name), name);
        for (const name of ['é', 'a.b', 'a-b', 'A', 'z']) { fs.writeFileSync(path.join(b.source, name), name); fs.utimesSync(path.join(b.source, name), 42, 42); fs.chmodSync(path.join(b.source, name), 0o755); }
        const first = await packPlugin(a.source, a.archive), second = await packPlugin(b.source, b.archive);
        expect(first.sha256).toBe(second.sha256); expect(first.revision).toBe(second.revision);
        expect(fs.readFileSync(a.archive)).toEqual(fs.readFileSync(b.archive));
    });
    it.each(['../escape', '/absolute', 'a/../escape', 'a\\escape', 'a//b', 'a%2fb', 'a:b', 'ui/NUL.txt', 'ui/COM¹.txt', 'ui/trailing.', 'ui/control\n', 'node_modules/a', '.git/config', '.GIT/config', 'NODE_MODULES/a', 'ui/\ud800', 'ui/\udc00', 'a'.repeat(256), 'é'.repeat(128)])('rejects unsafe or non-portable archive path %j', async name => {
        const h = fixture(); h.writeArchive(envelope([member(name)]));
        await expect(readPluginPackage(h.archive)).rejects.toThrow(/path|relative/);
    });
    it.each([
        ['same', 'same'], ['UI/a', 'ui/b'], ['ui/A', 'ui/a'], ['file', 'file/child'], ['file/child', 'file'], ['café', 'cafe\u0301'], ['ui/σ', 'ui/ς'], ['ui/long-s', 'ui/long-ſ'], ['ui/ß', 'ui/ẞ'],
    ])('rejects conflicting archive members %j and %j before extraction', async (a, b) => {
        const h = fixture(); h.writeArchive(envelope([member(a), member(b)]));
        await expect(readPluginPackage(h.archive)).rejects.toThrow('conflicting plugin paths');
        expect(fs.readdirSync(h.root).sort()).toEqual(['source', 'test.kelpi-plugin']);
    });
    it('rejects directory and file symlinks', async () => {
        const h = fixture(); fs.symlinkSync(h.root, path.join(h.source, 'outside'));
        await expect(readPluginPackage(h.source)).rejects.toThrow('symlinks');
        fs.unlinkSync(path.join(h.source, 'outside'));
        fs.symlinkSync(path.join(h.source, 'backend.mjs'), path.join(h.source, 'outside'));
        await expect(readPluginPackage(h.source)).rejects.toThrow('symlinks');
    });
    it('rejects missing entries, invalid manifests and incompatible API versions equally before packing/installing', async () => {
        const h = fixture(); fs.unlinkSync(path.join(h.source, 'ui/index.html'));
        await expect(packPlugin(h.source, h.archive)).rejects.toThrow('missing plugin entry');
        expect(fs.existsSync(h.archive)).toBe(false);
        fs.writeFileSync(path.join(h.source, 'ui/index.html'), 'restored');
        fs.writeFileSync(path.join(h.source, 'kelpi.plugin.json'), JSON.stringify({ ...h.manifest, apiVersion: 99 }));
        await expect(readPluginPackage(h.source)).rejects.toThrow('unsupported plugin API');
        fs.writeFileSync(path.join(h.source, 'kelpi.plugin.json'), '{}');
        await expect(readPluginPackage(h.source)).rejects.toThrow('plugin id');
        fs.unlinkSync(path.join(h.source, 'kelpi.plugin.json'));
        await expect(readPluginPackage(h.source)).rejects.toThrow('missing kelpi.plugin.json');
    });
    it('detects altered content, malformed encoding, unknown formats and damaged compression', async () => {
        const h = fixture(); await packPlugin(h.source, h.archive);
        const document = JSON.parse(gunzipSync(fs.readFileSync(h.archive)).toString());
        document.files.find((file: { path: string }) => file.path === 'backend.mjs').data = Buffer.from('tampered').toString('base64');
        h.writeArchive(document); await expect(readPluginPackage(h.archive)).rejects.toThrow('revision mismatch');
        h.writeArchive(envelope([member('a', '!!!!')])); await expect(readPluginPackage(h.archive)).rejects.toThrow('invalid base64');
        h.writeArchive({ ...envelope([]), formatVersion: 2 }); await expect(readPluginPackage(h.archive)).rejects.toThrow('unsupported plugin package format');
        fs.writeFileSync(h.archive, 'not gzip'); await expect(readPluginPackage(h.archive)).rejects.toThrow('invalid plugin archive');
    });
    it('bounds file count, regular file reads, compressed input and decompression', async () => {
        const h = fixture();
        h.writeArchive(envelope(Array.from({ length: 2001 }, (_, i) => member(String(i)))));
        await expect(readPluginPackage(h.archive)).rejects.toThrow('too many files');
        h.writeArchive(envelope(Array.from({ length: 1001 }, (_, i) => member(`${i}/nested/file`))));
        await expect(readPluginPackage(h.archive)).rejects.toThrow('too many directories');
        const chunk = Buffer.alloc(17 * 1024 * 1024).toString('base64');
        h.writeArchive(envelope([member('first', chunk), member('second', chunk)]));
        await expect(readPluginPackage(h.archive)).rejects.toThrow('exceeds 32 MiB');
        const oversized = path.join(h.source, 'large'); fs.writeFileSync(oversized, ''); fs.truncateSync(oversized, PLUGIN_PACKAGE_MAX_BYTES + 1);
        await expect(readPluginPackage(h.source)).rejects.toThrow('exceeds 32 MiB');
        fs.writeFileSync(h.archive, ''); fs.truncateSync(h.archive, 48 * 1024 * 1024 + 1);
        await expect(readPluginPackage(h.archive)).rejects.toThrow('archive exceeds 48 MiB');
        fs.writeFileSync(h.archive, gzipSync(Buffer.alloc(48 * 1024 * 1024 + 1)));
        await expect(readPluginPackage(h.archive)).rejects.toThrow('invalid plugin archive');
    });
    it('publishes atomically, refuses overwrites and refuses outputs inside the source even through aliases', async () => {
        const h = fixture(); fs.writeFileSync(h.archive, 'keep');
        await expect(packPlugin(h.source, h.archive)).rejects.toThrow('EEXIST');
        expect(fs.readFileSync(h.archive, 'utf8')).toBe('keep');
        expect(fs.readdirSync(h.root).sort()).toEqual(['source', 'test.kelpi-plugin']);
        await expect(packPlugin(h.source, path.join(h.source, 'out.kelpi-plugin'))).rejects.toThrow('outside the source');
        const alias = path.join(h.root, 'alias'); fs.symlinkSync(h.source, alias);
        await expect(packPlugin(h.source, path.join(alias, 'out.kelpi-plugin'))).rejects.toThrow('outside the source');
    });
});

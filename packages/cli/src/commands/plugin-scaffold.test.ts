import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest } from '@kelpi/protocol';
import { scaffoldPlugin } from './plugin-scaffold.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-plugin-scaffold-')); roots.push(value); return value; }

describe('offline plugin scaffold', () => {
    it('creates a validated package and a working backend command without a build', async () => {
        const result = scaffoldPlugin(path.join(root(), 'my plugin'), 'example.board', 'Board <one>');
        const manifest = decodePluginManifest(JSON.parse(fs.readFileSync(path.join(result.path, 'kelpi.plugin.json'), 'utf8')));
        expect(manifest.contributes.views[0]).toMatchObject({ id: result.viewID, placements: ['pane', 'sidebar.primary', 'sidebar.secondary'] });
        expect(fs.readFileSync(path.join(result.path, 'ui/index.html'), 'utf8')).toContain('Board &lt;one>');
        expect(() => new vm.Script(fs.readFileSync(path.join(result.path, 'ui/app.js'), 'utf8'))).not.toThrow();
        const module = await import(pathToFileURL(path.join(result.path, 'backend.mjs')).href);
        const unregister = vi.fn(); let handler: (() => Promise<unknown>) | undefined;
        const register = vi.fn((_id, fn) => { handler = fn; return unregister; });
        const deactivate = module.activate({ commands: { register }, workspaces: { list: async () => [{ id: 'W', paneCount: 3 }] } });
        expect(register).toHaveBeenCalledWith('example.board.summary', expect.any(Function));
        expect(await handler?.()).toMatchObject({ workspaces: [{ id: 'W', paneCount: 3 }] });
        deactivate(); expect(unregister).toHaveBeenCalledOnce();
    });
    it('validates names before creating files and refuses to overwrite any existing directory', () => {
        const existing = root();
        fs.writeFileSync(path.join(existing, 'keep.txt'), 'user content');
        expect(() => scaffoldPlugin(existing, 'example.board', 'Board')).toThrow();
        expect(fs.readdirSync(existing)).toEqual(['keep.txt']);
        const invalid = path.join(existing, 'invalid');
        expect(() => scaffoldPlugin(invalid, 'kelpi.reserved', 'Invalid')).toThrow('reserved');
        expect(fs.existsSync(invalid)).toBe(false);
    });
});

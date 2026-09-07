import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeFileAtomic } from './editor.js';
const dirs: string[] = [];
function fixture() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-edit-link-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
it('saves through chained symlinks and preserves the target mode', () => {
    const dir = fixture();
    const target = path.join(dir, 'target.md');
    fs.writeFileSync(target, 'original', { mode: 0o640 });
    fs.symlinkSync('target.md', path.join(dir, 'middle.md'));
    const link = path.join(dir, 'link.md');
    fs.symlinkSync('middle.md', link);
    writeFileAtomic(link, 'edited');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(dir, 'middle.md')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('edited');
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
});
it('refuses to overwrite a dangling symlink', () => {
    const link = path.join(fixture(), 'link.md');
    fs.symlinkSync('missing.md', link);
    expect(() => writeFileAtomic(link, 'edited')).toThrow();
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
});

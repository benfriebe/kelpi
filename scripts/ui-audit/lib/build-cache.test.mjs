import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundleHash, cacheDecision, writeRecordedHash } from './build-cache.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const fixture = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-build-cache-')); roots.push(root); return root; };
const write = (root, relative, content) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

describe('plugin SDK bundle cache dependencies', () => {
    it('invalidates browser and daemon bundles for an SDK-only source change', () => {
        const root = fixture();
        write(root, 'packages/plugin-sdk/api.js', 'export const version = 1;');
        const daemon = bundleHash(root, 'daemon'), client = bundleHash(root, 'client');
        write(root, 'packages/plugin-sdk/api.js', 'export const version = 2;');
        expect(bundleHash(root, 'daemon')).not.toBe(daemon);
        expect(bundleHash(root, 'client')).not.toBe(client);
    });

    it('rebuilds when the backend runner is missing even though the main artifact and hash survive', () => {
        const root = fixture();
        write(root, 'packages/daemon/dist/kelpid.js', 'daemon');
        write(root, 'packages/daemon/dist/runner.mjs', 'runner');
        writeRecordedHash(root, 'daemon', bundleHash(root, 'daemon'));
        expect(cacheDecision(root, 'daemon').cached).toBe(true);
        fs.unlinkSync(path.join(root, 'packages/daemon/dist/runner.mjs'));
        expect(cacheDecision(root, 'daemon')).toMatchObject({ cached: false, reason: 'missing companion artefact' });
    });
});

it('binds complete output bytes to stable build inputs and rejects altered, legacy, and partial receipts', () => {
    const root=fixture();
    write(root,'packages/cli/dist/kelpi.js','cli');
    write(root,'packages/cli/src/index.ts','source v1');
    const hash=bundleHash(root,'cli');
    writeRecordedHash(root,'cli',hash);
    expect(cacheDecision(root,'cli').cached).toBe(true);
    write(root,'packages/cli/dist/kelpi.js','altered');
    expect(cacheDecision(root,'cli')).toMatchObject({cached:false,reason:'outputs changed'});
    write(root,'packages/cli/dist/kelpi.js','cli');
    expect(cacheDecision(root,'cli').cached).toBe(true);
    write(root,'packages/cli/src/index.ts','source v2');
    expect(()=>writeRecordedHash(root,'cli',hash)).toThrow('inputs changed');
    expect(cacheDecision(root,'cli')).toMatchObject({cached:false,reason:'inputs changed'});
    for (const receipt of ['{',JSON.stringify({recipe:'buildAll/2',bundle:'cli',hash:bundleHash(root,'cli')})]) {
        write(root,'packages/cli/dist/.build-hash.json',receipt);
        expect(cacheDecision(root,'cli')).toMatchObject({cached:false,reason:'no recorded hash'});
    }
});

it('a failed receipt rename preserves the previous receipt and leaves no temporary output', () => {
    const root=fixture();write(root,'packages/cli/dist/kelpi.js','cli');
    const hash=bundleHash(root,'cli');writeRecordedHash(root,'cli',hash);
    const file=path.join(root,'packages/cli/dist/.build-hash.json'),before=fs.readFileSync(file,'utf8');
    const rename=vi.spyOn(fs,'renameSync').mockImplementationOnce(()=>{throw Error('injected receipt write failure');});
    try {expect(()=>writeRecordedHash(root,'cli',hash)).toThrow('injected receipt write failure');} finally {rename.mockRestore();}
    expect(fs.readFileSync(file,'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(file)).filter(name=>name.includes('.tmp-'))).toEqual([]);
    expect(cacheDecision(root,'cli').cached).toBe(true);
});

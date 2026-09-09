import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

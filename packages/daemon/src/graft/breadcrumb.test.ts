import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
    BREADCRUMB_FILENAME,
    breadcrumbPath,
    decodeBreadcrumb,
    encodeBreadcrumb,
    readBreadcrumb,
    removeBreadcrumb,
    writeBreadcrumb,
    type GraftBreadcrumb
} from './breadcrumb.js';

const roots: string[] = [];

function tmpRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-graft-crumb-'));
    roots.push(dir);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    return dir;
}

afterAll(() => {
    for (const root of roots) {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch {
            // best effort
        }
    }
});

const CRUMB: GraftBreadcrumb = {
    version: 1,
    stashed: true,
    assocId: '5E9C1B4E-6C1D-4A6B-9A87-2C51F0B0D001',
    stashRef: 'deadbeef42',
    worktreePath: '/Users/ben/nex/worktrees/feature-x',
    branch: 'feature/x',
    preGraftBranch: 'main',
    preGraftSha: '9f72d4f0c2b1',
    worktreePreGraftSha: null
};

describe('encodeBreadcrumb', () => {
    it('emits sorted keys, matching the Swift encoder byte for byte', () => {
        expect(encodeBreadcrumb(CRUMB)).toBe(
            '{"assocId":"5E9C1B4E-6C1D-4A6B-9A87-2C51F0B0D001","branch":"feature/x",' +
                '"preGraftBranch":"main","preGraftSha":"9f72d4f0c2b1","stashRef":"deadbeef42",' +
                '"stashed":true,"version":1,"worktreePath":"/Users/ben/nex/worktrees/feature-x",' +
                '"worktreePreGraftSha":null}'
        );
    });

    it('round-trips through decode', () => {
        expect(decodeBreadcrumb(encodeBreadcrumb(CRUMB))).toEqual(CRUMB);
    });
});

describe('decodeBreadcrumb tolerance', () => {
    it('ignores unparseable JSON, non-objects and arrays', () => {
        expect(decodeBreadcrumb('not json')).toBeNull();
        expect(decodeBreadcrumb('"a string"')).toBeNull();
        expect(decodeBreadcrumb('[1,2,3]')).toBeNull();
        expect(decodeBreadcrumb('')).toBeNull();
    });

    it('ignores any version other than 1', () => {
        expect(decodeBreadcrumb(JSON.stringify({ ...CRUMB, version: 2 }))).toBeNull();
        expect(decodeBreadcrumb(JSON.stringify({ ...CRUMB, version: '1' }))).toBeNull();
    });

    it('needs a worktree path to be usable', () => {
        expect(decodeBreadcrumb(JSON.stringify({ ...CRUMB, worktreePath: '' }))).toBeNull();
        const { worktreePath: _drop, ...rest } = CRUMB;
        expect(decodeBreadcrumb(JSON.stringify(rest))).toBeNull();
    });

    it('reads a LEGACY record with no preGraftBranch/preGraftSha (pre-capture)', () => {
        const legacy = JSON.stringify({
            version: 1,
            stashed: true,
            assocId: 'AB12CD34-0000-4000-8000-000000000001',
            stashRef: 'cafebabe',
            worktreePath: '/w/feature',
            branch: 'feature'
        });
        expect(decodeBreadcrumb(legacy)).toEqual({
            version: 1,
            stashed: true,
            assocId: 'AB12CD34-0000-4000-8000-000000000001',
            stashRef: 'cafebabe',
            worktreePath: '/w/feature',
            branch: 'feature',
            preGraftBranch: null,
            preGraftSha: null,
            worktreePreGraftSha: null
        });
    });

    it('reads a LEGACY commit-based record carrying worktreePreGraftSha', () => {
        const legacy = JSON.stringify({
            version: 1,
            assocId: 'AB12CD34-0000-4000-8000-000000000002',
            stashRef: null,
            worktreePath: '/w/feature',
            branch: 'feature',
            preGraftBranch: 'main',
            preGraftSha: 'aaaa',
            worktreePreGraftSha: 'bbbb'
        });
        const decoded = decodeBreadcrumb(legacy);
        expect(decoded?.worktreePreGraftSha).toBe('bbbb');
        // `stashed` is derivable when the field is missing.
        expect(decoded?.stashed).toBe(false);
    });

    it('derives `stashed` from stashRef when the flag is absent', () => {
        const raw = JSON.stringify({
            version: 1,
            assocId: 'x',
            stashRef: 'sha',
            worktreePath: '/w',
            branch: 'b'
        });
        expect(decodeBreadcrumb(raw)?.stashed).toBe(true);
    });

    it('falls back to the HEAD sentinel when the branch is missing', () => {
        const raw = JSON.stringify({ version: 1, worktreePath: '/w' });
        expect(decodeBreadcrumb(raw)?.branch).toBe('HEAD');
        expect(decodeBreadcrumb(raw)?.assocId).toBe('');
    });
});

describe('file IO', () => {
    it('writes to <root>/.git/nex-graft-active and round-trips', () => {
        const repo = tmpRepo();
        expect(breadcrumbPath(repo)).toBe(path.join(repo, '.git', BREADCRUMB_FILENAME));
        writeBreadcrumb(repo, CRUMB);
        expect(fs.existsSync(breadcrumbPath(repo))).toBe(true);
        expect(readBreadcrumb(repo)).toEqual(CRUMB);
    });

    it('reads a missing file as "no breadcrumb" and leaves garbage in place', () => {
        const repo = tmpRepo();
        expect(readBreadcrumb(repo)).toBeNull();
        fs.writeFileSync(breadcrumbPath(repo), '{ this is not json');
        expect(readBreadcrumb(repo)).toBeNull();
        // Misreading someone else's file is worse than ignoring it: the file survives.
        expect(fs.existsSync(breadcrumbPath(repo))).toBe(true);
    });

    it('removes idempotently', () => {
        const repo = tmpRepo();
        writeBreadcrumb(repo, CRUMB);
        removeBreadcrumb(repo);
        removeBreadcrumb(repo);
        expect(fs.existsSync(breadcrumbPath(repo))).toBe(false);
    });
});

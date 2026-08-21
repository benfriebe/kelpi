/**
 * §APP-071 / §GIT-092 — audit ledger **N5**: the status footer's `doc N +A -B` drew nothing
 * for any repository under a symlinked ancestor.
 *
 * These tests run against a **real symlinked temporary directory**, because the defect only
 * exists on the filesystem: the association carries git's PHYSICAL root and the pane carries
 * the LOGICAL cwd, and no fixture built by hand would have caught that (four green unit tests
 * of the selector shipped alongside a footer that rendered nothing, which is the whole reason
 * the claim standard now says an end-to-end run is the evidence).
 *
 * `os.tmpdir()` is itself symlinked on macOS (`/var/folders/…` → `/private/var/folders/…`), so
 * the fixture below builds its OWN symlink as well — the test must fail for the right reason
 * on Linux too, where `/tmp` usually is not a link.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makePane } from '@nex/core/layout';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizeForClient, clientPaths, createClientPathResolver } from './paths.js';
import { serializeAssociation } from './repos.js';
import { serializePane } from './serialize.js';
import type { RepoAssociation, Repo } from '../store/types.js';

const P1 = 'dddddddd-0000-4000-8000-000000000001';

/**
 * `<base>/link` → `<physicalRoot>/tree`, so `<base>/link/repo` and `<physicalRoot>/tree/repo`
 * are the same directory reached by two different strings — exactly the pane-vs-association
 * split in the field.
 */
function symlinkedFixture(): {
    readonly base: string;
    readonly logicalRepo: string;
    readonly physicalRepo: string;
    readonly cleanup: () => void;
} {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-n5-'));
    // The temp dir may itself sit under a symlink; resolve it so `physical*` below really is
    // the form `git rev-parse --show-toplevel` would print.
    const physicalRoot = fs.realpathSync(base);
    fs.mkdirSync(path.join(physicalRoot, 'tree', 'repo', 'packages'), { recursive: true });
    fs.symlinkSync(path.join(physicalRoot, 'tree'), path.join(physicalRoot, 'link'), 'dir');
    return {
        base: physicalRoot,
        logicalRepo: path.join(physicalRoot, 'link', 'repo'),
        physicalRepo: path.join(physicalRoot, 'tree', 'repo'),
        cleanup: () => {
            fs.rmSync(physicalRoot, { recursive: true, force: true });
        }
    };
}

const fixture = symlinkedFixture();

afterAll(() => {
    fixture.cleanup();
});

beforeEach(() => {
    clientPaths.reset();
});

function association(worktreePath: string): RepoAssociation {
    return {
        id: 'assoc-1',
        repoID: 'repo-1',
        worktreePath,
        branchName: 'main',
        isAutoDetected: false
    };
}

function repo(repoPath: string): Repo {
    return {
        id: 'repo-1',
        path: repoPath,
        name: 'repo',
        remoteURL: null,
        lastAccessedAt: 0,
        isAutoDiscovered: false
    };
}

describe('the N5 defect itself', () => {
    it('the two literal strings really do name the same directory and really do not match', () => {
        // Same inode…
        expect(fs.realpathSync(fixture.logicalRepo)).toBe(fixture.physicalRepo);
        expect(fixture.logicalRepo).not.toBe(fixture.physicalRepo);

        // …and this is the comparison the footer used to make: a pane sitting IN the repo,
        // tested against the association's root. It misses.
        const paneCwd = fixture.logicalRepo;
        const associationRoot = fixture.physicalRepo;
        const naiveMatch = paneCwd === associationRoot || paneCwd.startsWith(`${associationRoot}/`);
        expect(naiveMatch).toBe(false);
    });
});

describe('canonicalizeForClient', () => {
    it('resolves a symlinked ancestor to the physical path git would report', () => {
        expect(canonicalizeForClient(fixture.logicalRepo)).toBe(fixture.physicalRepo);
        expect(canonicalizeForClient(path.join(fixture.logicalRepo, 'packages'))).toBe(
            path.join(fixture.physicalRepo, 'packages')
        );
    });

    it('leaves an already-physical path alone', () => {
        expect(canonicalizeForClient(fixture.physicalRepo)).toBe(fixture.physicalRepo);
    });

    it('still answers for a directory that no longer exists', () => {
        // A pane whose cwd was deleted under it: `fs.realpathSync` throws ENOENT, and the
        // selector must not be handed an exception (or a blank) for it.
        const gone = path.join(fixture.logicalRepo, 'deleted-by-a-rebase');
        expect(fs.existsSync(gone)).toBe(false);
        expect(canonicalizeForClient(gone)).toBe(path.join(fixture.physicalRepo, 'deleted-by-a-rebase'));
    });

    it('returns the empty string for an empty cwd rather than inventing one', () => {
        expect(canonicalizeForClient('')).toBe('');
        expect(canonicalizeForClient('   ')).toBe('');
    });

    it('survives a realpath that throws outright', () => {
        const resolver = createClientPathResolver({
            realpath: () => {
                throw new Error('EACCES');
            }
        });
        // `canonicalizePath` walks to the root and hands back the standardized form, so the
        // consumer degrades to the literal comparison instead of losing the segment.
        expect(resolver.canonicalize('/some/where')).toBe('/some/where');
    });

    it('memoizes, and lets a re-pointed symlink through after the TTL', () => {
        let calls = 0;
        let clock = 1000;
        const resolver = createClientPathResolver({
            realpath: (input) => {
                calls += 1;
                return `${input}#${String(calls)}`;
            },
            now: () => clock,
            ttlMs: 5000
        });
        expect(resolver.canonicalize('/a')).toBe('/a#1');
        expect(resolver.canonicalize('/a')).toBe('/a#1');
        expect(calls).toBe(1);
        clock += 5001;
        expect(resolver.canonicalize('/a')).toBe('/a#2');
        expect(calls).toBe(2);
    });

    it('bounds the memo', () => {
        const resolver = createClientPathResolver({ realpath: (input) => input, cacheLimit: 4 });
        for (let i = 0; i < 20; i++) resolver.canonicalize(`/dir/${String(i)}`);
        expect(resolver.size()).toBeLessThanOrEqual(4);
    });
});

describe('what the client is handed', () => {
    it('serializePane keeps the logical cwd AND adds the canonical one', () => {
        const pane = makePane({
            id: P1,
            workingDirectory: fixture.logicalRepo,
            createdAt: 1,
            lastActivityAt: 2
        });
        const wire = serializePane(pane);
        // The displayed path is untouched: `pane list`'s CWD column, the footer's own
        // `~`-abbreviated label and `--prune-worktree` all read this one.
        expect(wire['workingDirectory']).toBe(fixture.logicalRepo);
        expect(wire['workingDirectoryReal']).toBe(fixture.physicalRepo);
    });

    it('serializeAssociation ships the canonical worktree root beside the literal one', () => {
        const wire = serializeAssociation(
            association(fixture.physicalRepo),
            repo(fixture.physicalRepo),
            fixture.base,
            { kind: 'dirty', changedFiles: 2, additions: 5, deletions: 5 }
        );
        expect(wire['worktree_path']).toBe(fixture.physicalRepo);
        expect(wire['worktree_path_real']).toBe(fixture.physicalRepo);
    });

    /**
     * The end of the defect: the two canonical forms the daemon now ships are the SAME string,
     * so the footer's prefix test — which is all `footerGitStats` does — can succeed. Before
     * this change the only two strings on the wire were the ones asserted not to match above.
     */
    it('makes the pane cwd and the association root comparable', () => {
        const paneWire = serializePane(
            makePane({ id: P1, workingDirectory: fixture.logicalRepo, createdAt: 1, lastActivityAt: 2 })
        );
        const associationWire = serializeAssociation(
            association(fixture.physicalRepo),
            repo(fixture.physicalRepo),
            fixture.base,
            { kind: 'dirty', changedFiles: 2, additions: 5, deletions: 5 }
        );
        const cwd = String(paneWire['workingDirectoryReal']);
        const root = String(associationWire['worktree_path_real']);
        expect(cwd === root || cwd.startsWith(`${root}/`)).toBe(true);
    });

    it('a pane in a SIBLING directory is still not inside the repo', () => {
        const sibling = path.join(fixture.base, 'link', 'repo-other');
        const paneWire = serializePane(
            makePane({ id: P1, workingDirectory: sibling, createdAt: 1, lastActivityAt: 2 })
        );
        const cwd = String(paneWire['workingDirectoryReal']);
        const root = fixture.physicalRepo;
        expect(cwd === root || cwd.startsWith(`${root}/`)).toBe(false);
    });
});

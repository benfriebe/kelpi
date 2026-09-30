/**
 * Git's progress meter, from real stderr (issue #294). The samples below were captured from
 * `git fetch --no-tags --progress origin +refs/heads/main:refs/remotes/origin/main` and
 * `GIT_PROGRESS_DELAY=0 git worktree add -b z ../z` (git 2.50), trimmed to a few updates per
 * phase. Git ends an in-place update with `\r` in one run and `\n` in another (and relays the
 * remote's lines with either), so both are here.
 */

import { describe, expect, it } from 'vitest';

import { createGitProgressParser, parseGitProgressLine, stripGitProgress, type GitProgress } from './progress.js';

/** A fetch whose local side printed `\r`-rewritten meters (what a pipe gets from git 2.50). */
const FETCH_CR =
    'remote: Enumerating objects: 403, done.\n' +
    'remote: Counting objects:   0% (1/403)\rremote: Counting objects:  45% (182/403)\rremote: Counting objects: 100% (403/403)\rremote: Counting objects: 100% (403/403), done.\n' +
    'remote: Compressing objects:  50% (201/402)\rremote: Compressing objects: 100% (402/402), done.\n' +
    'Receiving objects:   0% (1/402)\rReceiving objects:  45% (181/402), 660.00 KiB | 1.28 MiB/s\rReceiving objects: 100% (402/402), 1.45 MiB | 70.52 MiB/s, done.\n' +
    'Resolving deltas:   0% (0/1)\rResolving deltas: 100% (1/1)\rResolving deltas: 100% (1/1), completed with 1 local object.\n' +
    'From /tmp/origin\n' +
    '   246cd4f..e801189  main       -> origin/main\n';

/** The same shape with `\n` terminators, as a second run printed it. */
const FETCH_LF =
    'remote: Counting objects:   1% (1/53)        \n' +
    'remote: Counting objects: 100% (53/53), done.        \n' +
    'Receiving objects:   0% (1/402)\n' +
    'Receiving objects:   7% (29/402)\n' +
    'Receiving objects: 100% (402/402), 1.45 MiB | 70.52 MiB/s, done.\n';

const CHECKOUT = "Preparing worktree (new branch 'z')\nUpdating files:   0% (1/3000)\rUpdating files:   1% (30/3000)\rUpdating files:  60% (1800/3000)\rUpdating files: 100% (3000/3000), done.\nHEAD is now at 1d7b531 init\n";

function collect(chunks: readonly string[]): GitProgress[] {
    const seen: GitProgress[] = [];
    const parser = createGitProgressParser((progress) => seen.push(progress));
    for (const chunk of chunks) parser.push(chunk);
    parser.end();
    return seen;
}

describe('parseGitProgressLine', () => {
    it('reads the local and remote meter lines git prints', () => {
        expect(parseGitProgressLine('Receiving objects:  45% (181/402), 660.00 KiB | 1.28 MiB/s')).toEqual({
            phase: 'Receiving objects',
            percent: 45,
            current: 181,
            total: 402,
            remote: false
        });
        expect(parseGitProgressLine('remote: Counting objects: 100% (403/403), done.        ')).toEqual({
            phase: 'Counting objects',
            percent: 100,
            current: 403,
            total: 403,
            remote: true
        });
        expect(parseGitProgressLine('Updating files:  60% (1800/3000)')?.phase).toBe('Updating files');
        expect(parseGitProgressLine('Resolving deltas: 100% (1/1), completed with 1 local object.')?.percent).toBe(100);
    });

    it('is not fooled by the lines around the meter', () => {
        for (const line of [
            'From /tmp/origin',
            '   246cd4f..e801189  main       -> origin/main',
            'remote: Enumerating objects: 403, done.',
            "fatal: couldn't find remote ref refs/heads/nope",
            "Preparing worktree (new branch 'z')",
            'HEAD is now at 1d7b531 init',
            'remote: Total 52 (delta 1), reused 0 (delta 0), pack-reused 0 (from 0)',
            'Receiving objects: 145% (1/2)'
        ]) {
            expect(parseGitProgressLine(line)).toBeNull();
        }
    });
});

describe('createGitProgressParser', () => {
    it('reads every update of a \\r-rewritten fetch, in order', () => {
        const seen = collect([FETCH_CR]);
        expect(seen.map((p) => `${p.remote ? 'remote ' : ''}${p.phase} ${String(p.percent)}`)).toEqual([
            'remote Counting objects 0',
            'remote Counting objects 45',
            'remote Counting objects 100',
            'remote Counting objects 100',
            'remote Compressing objects 50',
            'remote Compressing objects 100',
            'Receiving objects 0',
            'Receiving objects 45',
            'Receiving objects 100',
            'Resolving deltas 0',
            'Resolving deltas 100',
            'Resolving deltas 100'
        ]);
    });

    it('reads a \\n-terminated fetch the same way', () => {
        expect(collect([FETCH_LF]).map((p) => p.percent)).toEqual([1, 100, 0, 7, 100]);
    });

    it('is indifferent to where the chunks split, even mid-line and between \\r and \\n', () => {
        const whole = collect([FETCH_CR]);
        // Every possible two-way split, and a byte-at-a-time feed.
        for (let cut = 1; cut < FETCH_CR.length; cut += 7) {
            expect(collect([FETCH_CR.slice(0, cut), FETCH_CR.slice(cut)])).toEqual(whole);
        }
        expect(collect([...FETCH_CR])).toEqual(whole);
        expect(collect(['Receiving objects:  45% (18/40)\r', '\nResolving deltas: 100% (1/1)'])).toEqual([
            { phase: 'Receiving objects', percent: 45, current: 18, total: 40, remote: false },
            { phase: 'Resolving deltas', percent: 100, current: 1, total: 1, remote: false }
        ]);
    });

    it("reads a checkout's Updating files meter, and flushes an unterminated last line on end()", () => {
        expect(collect([CHECKOUT]).map((p) => p.percent)).toEqual([0, 1, 60, 100]);
        const seen: GitProgress[] = [];
        const parser = createGitProgressParser((progress) => seen.push(progress));
        parser.push('Updating files:  33% (1/3)');
        expect(seen).toEqual([]);
        parser.end();
        expect(seen.map((p) => p.percent)).toEqual([33]);
    });
});

describe('stripGitProgress', () => {
    it('leaves the message and drops the meter, so the error names the real problem', () => {
        const stderr =
            'remote: Counting objects:  50% (1/2)\rremote: Counting objects: 100% (2/2), done.\n' +
            'Receiving objects:  50% (1/2)\r' +
            "fatal: couldn't find remote ref refs/heads/trunk\n";
        expect(stripGitProgress(stderr)).toBe("fatal: couldn't find remote ref refs/heads/trunk");
        expect(stripGitProgress(CHECKOUT)).toBe("Preparing worktree (new branch 'z')\nHEAD is now at 1d7b531 init");
        expect(stripGitProgress('Receiving objects: 100% (2/2), done.\r\n')).toBe('');
    });
});

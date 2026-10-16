import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createGhRunner, ghBinaryCandidates, resolveGhExecutable } from './gh.js';

const dirs: string[] = [];
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-gh-'));
    dirs.push(dir);
    return dir;
}

function stub(dir: string, script: string): string {
    const file = path.join(dir, 'gh');
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return file;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ghBinaryCandidates', () => {
    it('searches PATH first, then the Homebrew prefixes the launchd PATH lacks', () => {
        expect(ghBinaryCandidates({ PATH: '/a:/b' })).toEqual(['/a/gh', '/b/gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']);
        expect(ghBinaryCandidates({})).toEqual(['/opt/homebrew/bin/gh', '/usr/local/bin/gh']);
    });

    it('takes KELPI_GH alone', () => {
        expect(ghBinaryCandidates({ KELPI_GH: ' /x/gh ', PATH: '/a' })).toEqual(['/x/gh']);
    });
});

describe('createGhRunner', () => {
    it('runs the binary with an argument array and the background environment', async () => {
        const dir = tempDir();
        const gh = stub(dir, 'printf "%s|" "$@"; printf "%s %s %s" "$GH_PROMPT_DISABLED" "$GH_NO_UPDATE_NOTIFIER" "$NO_COLOR"');
        const run = createGhRunner({ env: { KELPI_GH: gh } });
        const result = await run(['pr', 'list', '--head=a b;rm -rf /']);
        expect(result).toEqual({ code: 0, stdout: 'pr|list|--head=a b;rm -rf /|1 1 1', stderr: '', missing: false, timedOut: false });
    });

    it('reports the exit code and stderr of a failure', async () => {
        const dir = tempDir();
        const gh = stub(dir, 'echo "not logged in" >&2; exit 4');
        const result = await createGhRunner({ env: { KELPI_GH: gh } })(['auth', 'status']);
        expect(result).toMatchObject({ code: 4, stderr: 'not logged in\n', missing: false, timedOut: false });
    });

    it('is missing when no candidate exists, and finds one installed later', async () => {
        const dir = tempDir();
        expect(resolveGhExecutable({ KELPI_GH: path.join(dir, 'nope') })).toBeNull();
        const run = createGhRunner({ env: { KELPI_GH: path.join(dir, 'gh') } });
        expect(await run(['auth', 'status'])).toMatchObject({ missing: true, code: -1 });
        stub(dir, 'echo ok');
        expect(await run(['auth', 'status'])).toMatchObject({ missing: false, code: 0, stdout: 'ok\n' });
    });

    it('kills a hung gh at its timeout', async () => {
        const dir = tempDir();
        const gh = stub(dir, 'sleep 5');
        const result = await createGhRunner({ env: { KELPI_GH: gh }, timeoutMs: 100 })(['pr', 'list']);
        expect(result).toMatchObject({ code: -1, missing: false, timedOut: true });
    });
});

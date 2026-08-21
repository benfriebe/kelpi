/**
 * §APP-006 — the launch-time refresh of the bundled `nex-agentic` document.
 *
 * The first port of this step wrote into a real home because Electron's `app.getPath('home')`
 * ignores `$HOME`. Everything below therefore runs inside an `mkdtemp` root with a FAKE `HOME`,
 * and the suite asserts, on every case that writes, that the machine's real home was not
 * touched — the check that would have caught the original incident before it happened.
 *
 * The cases are the promises the module makes: it never installs where the user has not opted
 * in, it never overwrites a document it cannot prove it wrote, it never rolls a newer document
 * backwards, and it refreshes exactly the one case that is left.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    SKILL_FILE,
    SKILL_MARKER_FILE,
    bundledSkillDir,
    compareSkillVersions,
    describeSkillRefresh,
    hashContents,
    nodeSkillFs,
    parseSkillMarker,
    refreshBundledSkill,
    resolveHomeDirectory,
    skillDestinationDir,
    skillVersion
} from './skill.js';

let root = '';
let home = '';
let sourceDir = '';
/** What the real home's document looked like before the test — it must not change. */
let realHomeBefore: { path: string; contents: string | null } = { path: '', contents: null };

const BUNDLED = '---\nname: nex-agentic\n---\n\n# bundled\n';

function realHomeSkillFile(): string {
    const realHome = process.env['HOME'] ?? os.homedir();
    return path.join(realHome, '.claude', 'skills', 'nex-agentic', SKILL_FILE);
}

function readIfPresent(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

/** Lay down an installed copy plus the marker that proves this app wrote it. */
function installOurs(contents: string): void {
    const destDir = skillDestinationDir(home);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, SKILL_FILE), contents);
    fs.writeFileSync(
        path.join(destDir, SKILL_MARKER_FILE),
        `${JSON.stringify({
            installedHash: hashContents(contents),
            sourceHash: hashContents(contents),
            version: skillVersion(contents),
            appVersion: '0.1.0',
            installedAt: '2026-08-01T00:00:00.000Z',
            by: 'nex-shell'
        })}\n`
    );
}

function refresh(env: NodeJS.ProcessEnv = { HOME: home, NEX_SKILL_SOURCE: sourceDir }) {
    return refreshBundledSkill({ env, appVersion: '0.2.0', now: () => new Date(0) }, nodeSkillFs);
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-skill-'));
    home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    sourceDir = path.join(root, 'bundle', 'skills', 'nex-agentic');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, SKILL_FILE), BUNDLED);
    const realFile = realHomeSkillFile();
    realHomeBefore = { path: realFile, contents: readIfPresent(realFile) };
});

afterEach(() => {
    // The assertion the incident earned. Whatever a case did, the machine's own home is as it
    // was — including "still absent" when it was absent.
    expect(readIfPresent(realHomeBefore.path)).toBe(realHomeBefore.contents);
    fs.rmSync(root, { recursive: true, force: true });
});

describe('where the destination comes from', () => {
    it('reads $HOME out of the environment it is handed, and nothing else', () => {
        expect(resolveHomeDirectory({ HOME: '/Users/someone' })).toBe('/Users/someone');
        expect(skillDestinationDir('/Users/someone')).toBe('/Users/someone/.claude/skills/nex-agentic');
    });

    it('refuses an empty or relative HOME rather than resolving one', () => {
        expect(resolveHomeDirectory({})).toBeNull();
        expect(resolveHomeDirectory({ HOME: '   ' })).toBeNull();
        expect(resolveHomeDirectory({ HOME: 'relative/home' })).toBeNull();
        expect(refresh({ HOME: '', NEX_SKILL_SOURCE: sourceDir })).toMatchObject({
            action: 'skipped',
            reason: 'no-home'
        });
    });

    it('takes the bundled document from the app’s resources, or the harness override', () => {
        expect(bundledSkillDir({ env: {}, resourcesPath: '/Apps/Nex.app/Contents/Resources' })).toBe(
            '/Apps/Nex.app/Contents/Resources/cli/skills/nex-agentic'
        );
        expect(bundledSkillDir({ env: { NEX_SKILL_SOURCE: '/tmp/skills/nex-agentic' } })).toBe(
            '/tmp/skills/nex-agentic'
        );
        // A dev run carries no payload, and that is a skip rather than an error.
        expect(bundledSkillDir({ env: {} })).toBeNull();
        expect(refresh({ HOME: home })).toMatchObject({ action: 'skipped', reason: 'no-bundled-skill' });
    });
});

describe('what it refuses to do', () => {
    /** The Swift's rule: the skill is installed by an explicit user action, never by launching. */
    it('does not create the skill directory on the user’s behalf', () => {
        const result = refresh();
        expect(result).toMatchObject({ action: 'skipped', reason: 'not-installed' });
        expect(fs.existsSync(skillDestinationDir(home))).toBe(false);
    });

    it('leaves a copy it cannot prove it wrote byte-for-byte alone', () => {
        const destDir = skillDestinationDir(home);
        fs.mkdirSync(destDir, { recursive: true });
        const edited = '# my own notes\n\nhands off\n';
        fs.writeFileSync(path.join(destDir, SKILL_FILE), edited);

        const result = refresh();
        expect(result).toMatchObject({ action: 'skipped', reason: 'user-modified' });
        expect(fs.readFileSync(path.join(destDir, SKILL_FILE), 'utf8')).toBe(edited);
        // …and it did not leave a marker behind either: no write means no write.
        expect(fs.existsSync(path.join(destDir, SKILL_MARKER_FILE))).toBe(false);
    });

    it('leaves an EDITED copy of its own installation alone once the hash stops matching', () => {
        installOurs('---\nname: nex-agentic\n---\n\n# older\n');
        const destFile = path.join(skillDestinationDir(home), SKILL_FILE);
        const edited = `${fs.readFileSync(destFile, 'utf8')}\n## my addition\n`;
        fs.writeFileSync(destFile, edited);

        expect(refresh()).toMatchObject({ action: 'skipped', reason: 'user-modified' });
        expect(fs.readFileSync(destFile, 'utf8')).toBe(edited);
    });

    it('never rolls a newer installed document backwards', () => {
        fs.writeFileSync(path.join(sourceDir, SKILL_FILE), '---\nversion: 1.2.0\n---\n\n# bundled\n');
        installOurs('---\nversion: 1.3.0\n---\n\n# newer already\n');
        const destFile = path.join(skillDestinationDir(home), SKILL_FILE);

        expect(refresh()).toMatchObject({ action: 'skipped', reason: 'not-newer' });
        expect(fs.readFileSync(destFile, 'utf8')).toContain('newer already');
    });

    it('reports the already-current case without rewriting the document', () => {
        installOurs(BUNDLED);
        const destFile = path.join(skillDestinationDir(home), SKILL_FILE);
        const before = fs.statSync(destFile).mtimeMs;
        expect(refresh()).toMatchObject({ action: 'unchanged', reason: 'identical' });
        expect(fs.statSync(destFile).mtimeMs).toBe(before);
    });
});

/**
 * The case that decides whether this step is useful at all.
 *
 * In this port the skill is installed by `nex install-hooks`, which leaves no ownership marker.
 * If an unmarked copy could never be adopted, the launch refresh would decline forever and the
 * feature would be inert for every real user. A copy that is byte-identical to the bundled
 * document cannot have been edited relative to this build, so it — and only it — is adopted.
 */
describe('adopting a copy `nex install-hooks` wrote', () => {
    it('records ownership for an identical, unmarked copy so the NEXT release can refresh it', () => {
        const destDir = skillDestinationDir(home);
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, SKILL_FILE), BUNDLED);

        expect(refresh()).toMatchObject({ action: 'unchanged', reason: 'identical' });
        const marker = parseSkillMarker(fs.readFileSync(path.join(destDir, SKILL_MARKER_FILE), 'utf8'));
        expect(marker?.installedHash).toBe(hashContents(BUNDLED));
        // The document itself was not rewritten — adoption is a marker, not a copy.
        expect(fs.readFileSync(path.join(destDir, SKILL_FILE), 'utf8')).toBe(BUNDLED);

        // …and now a newer bundle is allowed to land.
        fs.writeFileSync(path.join(sourceDir, SKILL_FILE), '---\nname: nex-agentic\n---\n\n# next release\n');
        expect(refresh()).toMatchObject({ action: 'updated', reason: 'stale' });
        expect(fs.readFileSync(path.join(destDir, SKILL_FILE), 'utf8')).toContain('next release');
    });

    it('does NOT adopt a copy whose bytes differ — that one is the user’s', () => {
        const destDir = skillDestinationDir(home);
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, SKILL_FILE), `${BUNDLED}\n## mine\n`);

        expect(refresh()).toMatchObject({ action: 'skipped', reason: 'user-modified' });
        expect(fs.existsSync(path.join(destDir, SKILL_MARKER_FILE))).toBe(false);
    });
});

describe('what it does do', () => {
    it('fills in a missing document under a directory the user already has', () => {
        fs.mkdirSync(skillDestinationDir(home), { recursive: true });
        const result = refresh();
        expect(result).toMatchObject({ action: 'installed', reason: 'absent' });
        const destFile = path.join(skillDestinationDir(home), SKILL_FILE);
        expect(fs.readFileSync(destFile, 'utf8')).toBe(BUNDLED);

        const marker = parseSkillMarker(
            fs.readFileSync(path.join(skillDestinationDir(home), SKILL_MARKER_FILE), 'utf8')
        );
        expect(marker?.installedHash).toBe(hashContents(BUNDLED));
        expect(marker?.appVersion).toBe('0.2.0');
    });

    it('replaces its own stale installation, and the marker follows the new bytes', () => {
        installOurs('---\nname: nex-agentic\n---\n\n# older\n');
        expect(refresh()).toMatchObject({ action: 'updated', reason: 'stale' });
        const destDir = skillDestinationDir(home);
        expect(fs.readFileSync(path.join(destDir, SKILL_FILE), 'utf8')).toBe(BUNDLED);
        const marker = parseSkillMarker(fs.readFileSync(path.join(destDir, SKILL_MARKER_FILE), 'utf8'));
        expect(marker?.installedHash).toBe(hashContents(BUNDLED));
    });

    /** A refresh is idempotent: the second launch of the same build does nothing at all. */
    it('is a no-op on the next launch', () => {
        fs.mkdirSync(skillDestinationDir(home), { recursive: true });
        expect(refresh().action).toBe('installed');
        expect(refresh()).toMatchObject({ action: 'unchanged', reason: 'identical' });
    });

    it('upgrades when both documents declare a version and the bundle is ahead', () => {
        fs.writeFileSync(path.join(sourceDir, SKILL_FILE), '---\nversion: 2.0.0\n---\n\n# bundled\n');
        installOurs('---\nversion: 1.9.9\n---\n\n# older\n');
        expect(refresh()).toMatchObject({ action: 'updated', reason: 'stale' });
        expect(fs.readFileSync(path.join(skillDestinationDir(home), SKILL_FILE), 'utf8')).toContain('2.0.0');
    });

    it('reports a write it could not make instead of throwing', () => {
        fs.mkdirSync(skillDestinationDir(home), { recursive: true });
        const result = refreshBundledSkill(
            { env: { HOME: home, NEX_SKILL_SOURCE: sourceDir } },
            {
                readFile: nodeSkillFs.readFile,
                isDirectory: nodeSkillFs.isDirectory,
                writeFile() {
                    throw new Error('EROFS: read-only file system');
                }
            }
        );
        expect(result).toMatchObject({ action: 'failed', reason: 'write-failed' });
        expect(describeSkillRefresh(result)).toContain('read-only file system');
    });
});

describe('the version and marker helpers', () => {
    it('reads a front-matter version, and tolerates a document without one', () => {
        expect(skillVersion('---\nname: x\nversion: "1.4"\n---\nbody\n')).toBe('1.4');
        expect(skillVersion('---\nname: x\n---\nbody\n')).toBeNull();
        expect(skillVersion('# no front matter\n')).toBeNull();
        expect(skillVersion(null)).toBeNull();
    });

    it('orders dotted versions and gives up honestly on anything else', () => {
        expect(compareSkillVersions('1.2.0', '1.1.9')).toBe(1);
        expect(compareSkillVersions('1.2', '1.2.0')).toBe(0);
        expect(compareSkillVersions('1.2.0', '1.3')).toBe(-1);
        expect(compareSkillVersions('2026-08-21', '1.0')).toBeNull();
        expect(compareSkillVersions(null, '1.0')).toBeNull();
    });

    it('treats a corrupt marker as no marker, which means "do not touch"', () => {
        expect(parseSkillMarker('{oops')).toBeNull();
        expect(parseSkillMarker('{}')).toBeNull();
        const destDir = skillDestinationDir(home);
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, SKILL_FILE), '# theirs\n');
        fs.writeFileSync(path.join(destDir, SKILL_MARKER_FILE), 'not json at all');
        expect(refresh()).toMatchObject({ action: 'skipped', reason: 'user-modified' });
        expect(fs.readFileSync(path.join(destDir, SKILL_FILE), 'utf8')).toBe('# theirs\n');
    });

    it('describes an outcome in one line for the launch log', () => {
        fs.mkdirSync(skillDestinationDir(home), { recursive: true });
        expect(describeSkillRefresh(refresh())).toMatch(/^skill-refresh: installed \(absent\) /);
    });
});

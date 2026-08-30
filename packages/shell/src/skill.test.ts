/**
 * §APP-006 — the launch-time refresh of the bundled `nex-agentic` document.
 *
 * The first port of this step wrote into a real home because Electron's `app.getPath('home')`
 * ignores `$HOME`. Everything below therefore runs inside an `mkdtemp` root with a FAKE `HOME`,
 * and the suite asserts, on every case that writes, that the machine's real home was not
 * touched — the check that would have caught the original incident before it happened.
 *
 * The cases are the promises the module makes: it never installs where the user has not opted
 * in, it never overwrites a MARKED document whose bytes it cannot account for, it never rolls a
 * newer document backwards, it migrates the pre-marker copies exactly once and never destroys
 * anything doing it, and it refreshes its own installations.
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
    skillBackupFile,
    skillBackupStamp,
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
            by: 'kelpi-shell'
        })}\n`
    );
}

/**
 * Lay down an installed copy with NO marker beside it — what `kelpi install-hooks` leaves, and
 * what every copy on disk before this app kept receipts looks like.
 */
function installUnmarked(contents: string): string {
    const destDir = skillDestinationDir(home);
    fs.mkdirSync(destDir, { recursive: true });
    const file = path.join(destDir, SKILL_FILE);
    fs.writeFileSync(file, contents);
    return file;
}

/** Every `SKILL.md.bak-…` in the destination directory, sorted. */
function backupsInDest(): string[] {
    const destDir = skillDestinationDir(home);
    return fs
        .readdirSync(destDir)
        .filter((entry) => entry.startsWith(`${SKILL_FILE}.bak-`))
        .sort();
}

function refresh(env: NodeJS.ProcessEnv = { HOME: home, KELPI_SKILL_SOURCE: sourceDir }) {
    return refreshBundledSkill({ env, appVersion: '0.2.0', now: () => new Date(0) }, nodeSkillFs);
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-skill-'));
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
        expect(refresh({ HOME: '', KELPI_SKILL_SOURCE: sourceDir })).toMatchObject({
            action: 'skipped',
            reason: 'no-home'
        });
    });

    it('takes the bundled document from the app’s resources, or the harness override', () => {
        expect(bundledSkillDir({ env: {}, resourcesPath: '/Apps/Kelpi.app/Contents/Resources' })).toBe(
            '/Apps/Kelpi.app/Contents/Resources/cli/skills/nex-agentic'
        );
        expect(bundledSkillDir({ env: { KELPI_SKILL_SOURCE: '/tmp/skills/nex-agentic' } })).toBe(
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

    /**
     * The sovereignty rule, in the shape that survives the migration below: a MARKED copy whose
     * bytes have stopped matching its marker is the user's edit of something this app installed,
     * and it is never touched again — not overwritten, and not "helpfully" backed up either.
     */
    it('leaves an EDITED copy of its own installation alone once the hash stops matching', () => {
        installOurs('---\nname: nex-agentic\n---\n\n# older\n');
        const destFile = path.join(skillDestinationDir(home), SKILL_FILE);
        const edited = `${fs.readFileSync(destFile, 'utf8')}\n## my addition\n`;
        fs.writeFileSync(destFile, edited);

        expect(refresh()).toMatchObject({ action: 'skipped', reason: 'user-modified' });
        expect(fs.readFileSync(destFile, 'utf8')).toBe(edited);
        expect(backupsInDest()).toEqual([]);
        // A second launch says the same thing: this is permanent, not a one-launch grace period.
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

    /**
     * The version guard outranks the migration. An UNMARKED copy that declares a version ahead
     * of the bundle is not a stale pre-marker install — it is a newer document that arrived by
     * some other route, and moving it aside to install an older one would be the roll-back the
     * guard exists to prevent.
     */
    it('never migrates an unmarked copy that declares a NEWER version', () => {
        fs.writeFileSync(path.join(sourceDir, SKILL_FILE), '---\nversion: 1.2.0\n---\n\n# bundled\n');
        const ahead = '---\nversion: 1.3.0\n---\n\n# newer already, and unmarked\n';
        const destFile = installUnmarked(ahead);

        expect(refresh()).toMatchObject({ action: 'skipped', reason: 'not-newer' });
        expect(fs.readFileSync(destFile, 'utf8')).toBe(ahead);
        expect(backupsInDest()).toEqual([]);
        expect(fs.existsSync(path.join(skillDestinationDir(home), SKILL_MARKER_FILE))).toBe(false);
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
 * In this port the skill is installed by `kelpi install-hooks`, which leaves no ownership marker.
 * If an unmarked copy could never be adopted, the launch refresh would decline forever and the
 * feature would be inert for every real user. A copy that is byte-identical to the bundled
 * document cannot have been edited relative to this build, so it — and only it — is adopted.
 */
describe('adopting a copy `kelpi install-hooks` wrote', () => {
    it('records ownership for an identical, unmarked copy so the KELPIT release can refresh it', () => {
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

    it('adopts nothing when the bytes differ — that copy goes down the migration path instead', () => {
        const destFile = installUnmarked(`${BUNDLED}\n## drifted\n`);

        // Not `unchanged (identical)`, which is what adoption is: this one is healed, and the
        // suite below is what that means.
        const result = refresh();
        expect(result.action).toBe('healed');
        expect(fs.readFileSync(destFile, 'utf8')).toBe(BUNDLED);
    });
});

/**
 * §APP-006's migration — the case the first version of this module left stranded.
 *
 * Rule 2 as first written declined an unmarked drifted copy, which is *every* copy
 * `kelpi install-hooks` ever made: the launch step could adopt one that happened to be identical
 * and could never refresh a stale one, so the Swift's own primary case never happened here. The
 * resolution is a one-time migration that cannot lose anything — the drifted document is moved
 * aside to a `.bak-<stamp>` name, the bundle is installed, and the marker goes down beside it.
 * From that moment the copy is marked, so the user's next edit lands in rule 2 and is theirs
 * forever: one-time by construction, not by a flag anybody has to remember to set.
 */
describe('migrating a drifted, unmarked copy — once', () => {
    const DRIFTED = '# nex-agentic\n\nfrom some older build\n';

    it('backs the old bytes up, installs the bundle, and records ownership', () => {
        const destFile = installUnmarked(DRIFTED);

        const result = refresh();
        expect(result).toMatchObject({ action: 'healed', reason: 'drifted-unmarked' });

        // The bundled document landed, byte for byte.
        expect(fs.readFileSync(destFile, 'utf8')).toBe(BUNDLED);

        // The old one is beside it, byte for byte, under an ISO-ish stamp.
        const backups = backupsInDest();
        expect(backups).toHaveLength(1);
        expect(backups[0]).toMatch(/^SKILL\.md\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
        expect(fs.readFileSync(path.join(skillDestinationDir(home), backups[0] ?? ''), 'utf8')).toBe(DRIFTED);
        expect(result.backup).toBe(path.join(skillDestinationDir(home), backups[0] ?? ''));

        // And the marker, which is what makes this a one-time event.
        const marker = parseSkillMarker(
            fs.readFileSync(path.join(skillDestinationDir(home), SKILL_MARKER_FILE), 'utf8')
        );
        expect(marker?.installedHash).toBe(hashContents(BUNDLED));

        // The launch log names where the old document went — the only thing a person reading
        // that line needs from it.
        expect(describeSkillRefresh(result)).toContain(`healed (backed up drifted copy to ${backups[0] ?? ''})`);
    });

    it('is a no-op on the next launch — no second backup, no second write', () => {
        const destFile = installUnmarked(DRIFTED);
        expect(refresh().action).toBe('healed');
        const mtime = fs.statSync(destFile).mtimeMs;

        expect(refresh()).toMatchObject({ action: 'unchanged', reason: 'identical' });
        expect(backupsInDest()).toHaveLength(1);
        expect(fs.statSync(destFile).mtimeMs).toBe(mtime);
        expect(fs.readFileSync(destFile, 'utf8')).toBe(BUNDLED);
    });

    /** The whole argument for the migration being safe: after it, sovereignty applies. */
    it('hands the copy back to the user: an edit AFTER the heal is never migrated again', () => {
        const destFile = installUnmarked(DRIFTED);
        expect(refresh().action).toBe('healed');

        const mine = `${BUNDLED}\n## my own additions\n`;
        fs.writeFileSync(destFile, mine);
        // …and a newer bundle arrives, so there is every reason to want to refresh.
        fs.writeFileSync(path.join(sourceDir, SKILL_FILE), '---\nname: nex-agentic\n---\n\n# next release\n');

        expect(refresh()).toMatchObject({ action: 'skipped', reason: 'user-modified' });
        expect(fs.readFileSync(destFile, 'utf8')).toBe(mine);
        expect(backupsInDest()).toHaveLength(1); // still just the migration's own
    });

    it('never writes over an existing backup — it takes the next free name', () => {
        const destDir = skillDestinationDir(home);
        const destFile = installUnmarked(DRIFTED);
        // A backup from an earlier attempt at the same (frozen) timestamp, and its own successor.
        const taken = path.join(destDir, 'SKILL.md.bak-1970-01-01T00-00-00Z');
        fs.writeFileSync(taken, 'an earlier backup nobody may touch\n');
        fs.writeFileSync(`${taken}-2`, 'and the one after it\n');

        const result = refresh();
        expect(result).toMatchObject({ action: 'healed', reason: 'drifted-unmarked' });
        expect(result.backup).toBe(`${taken}-3`);
        expect(fs.readFileSync(`${taken}-3`, 'utf8')).toBe(DRIFTED);
        // The two that were there are exactly as they were.
        expect(fs.readFileSync(taken, 'utf8')).toBe('an earlier backup nobody may touch\n');
        expect(fs.readFileSync(`${taken}-2`, 'utf8')).toBe('and the one after it\n');
        expect(fs.readFileSync(destFile, 'utf8')).toBe(BUNDLED);
    });

    it('does not replace a copy it could not move aside', () => {
        const destFile = installUnmarked(DRIFTED);
        const result = refreshBundledSkill(
            { env: { HOME: home, KELPI_SKILL_SOURCE: sourceDir }, now: () => new Date(0) },
            {
                ...nodeSkillFs,
                rename() {
                    throw new Error('EXDEV: cross-device link not permitted');
                }
            }
        );
        expect(result).toMatchObject({ action: 'failed', reason: 'backup-failed' });
        expect(describeSkillRefresh(result)).toContain('cross-device link');
        // Nothing was destroyed to make room for the bundle.
        expect(fs.readFileSync(destFile, 'utf8')).toBe(DRIFTED);
        expect(backupsInDest()).toEqual([]);
        expect(fs.existsSync(path.join(skillDestinationDir(home), SKILL_MARKER_FILE))).toBe(false);
    });

    it('puts the backup back when the install that follows it fails', () => {
        const destFile = installUnmarked(DRIFTED);
        const result = refreshBundledSkill(
            { env: { HOME: home, KELPI_SKILL_SOURCE: sourceDir }, now: () => new Date(0) },
            {
                ...nodeSkillFs,
                writeFile() {
                    throw new Error('ENOSPC: no space left on device');
                }
            }
        );
        expect(result).toMatchObject({ action: 'failed', reason: 'write-failed' });
        expect(fs.readFileSync(destFile, 'utf8')).toBe(DRIFTED);
        expect(backupsInDest()).toEqual([]);
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
            { env: { HOME: home, KELPI_SKILL_SOURCE: sourceDir } },
            {
                ...nodeSkillFs,
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

    /**
     * A marker that will not parse proves nothing about the bytes — but its PRESENCE proves
     * something wrote here deliberately, which is exactly what the migration's "no marker at
     * all" case cannot say. So the unreadable-marker copy is left alone, and it is not backed
     * up either: a document is only moved aside when it is about to be replaced.
     */
    it('treats a marker it cannot read as evidence, not as an absent marker', () => {
        expect(parseSkillMarker('{oops')).toBeNull();
        expect(parseSkillMarker('{}')).toBeNull();
        const destDir = skillDestinationDir(home);
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, SKILL_FILE), '# theirs\n');
        fs.writeFileSync(path.join(destDir, SKILL_MARKER_FILE), 'not json at all');
        expect(refresh()).toMatchObject({ action: 'skipped', reason: 'user-modified' });
        expect(fs.readFileSync(path.join(destDir, SKILL_FILE), 'utf8')).toBe('# theirs\n');
        expect(backupsInDest()).toEqual([]);
    });

    it('stamps a backup name with a sortable, filename-safe ISO time', () => {
        expect(skillBackupStamp(new Date('2026-08-22T13:45:01.123Z'))).toBe('2026-08-22T13-45-01Z');
        const destDir = skillDestinationDir(home);
        fs.mkdirSync(destDir, { recursive: true });
        expect(skillBackupFile(destDir, '2026-08-22T13-45-01Z', nodeSkillFs)).toBe(
            path.join(destDir, 'SKILL.md.bak-2026-08-22T13-45-01Z')
        );
        // Even a name it cannot READ counts as occupied — `exists`, not `readFile`.
        fs.writeFileSync(path.join(destDir, 'SKILL.md.bak-2026-08-22T13-45-01Z'), 'taken');
        expect(skillBackupFile(destDir, '2026-08-22T13-45-01Z', { ...nodeSkillFs, readFile: () => null })).toBe(
            path.join(destDir, 'SKILL.md.bak-2026-08-22T13-45-01Z-2')
        );
    });

    it('describes an outcome in one line for the launch log', () => {
        fs.mkdirSync(skillDestinationDir(home), { recursive: true });
        expect(describeSkillRefresh(refresh())).toMatch(/^skill-refresh: installed \(absent\) /);
    });
});

/**
 * §APP-006 — refreshing the bundled `kelpi-agentic` document at launch.
 *
 * The Swift app re-copies `Contents/Resources/skills/kelpi-agentic/SKILL.md` into
 * `~/.claude/skills/kelpi-agentic/` on every launch, but only when the destination directory
 * already exists (it never creates one on the user's behalf) and only when the bytes differ
 * (`CLIInstallService.swift:163-191`).
 *
 * **This module exists because a port of that step once damaged a real file.** Electron's
 * `app.getPath('home')` asks the OS (`NSHomeDirectory()`) and ignores `$HOME`, so a step written
 * against it wrote into the developer's own home while every harness in this repo had `HOME`
 * pointed at a throwaway directory. Two rules follow from that, and neither is negotiable:
 *
 *  1. **The home directory is an input, never a lookup.** `resolveHomeDirectory` reads `$HOME`
 *     out of an injected environment — the same source the CLI, `install-hooks` and Claude Code
 *     itself use — and nothing in this file imports Electron. A test that redirects `HOME`
 *     redirects this module, completely.
 *  2. **A file this app did not write is never overwritten.** The Swift step clobbers any
 *     drifted copy; this one refuses to, because a `SKILL.md` a user has edited is *their*
 *     document. Ownership is proved by a marker written beside the file recording the hash of
 *     exactly what was installed — if the file on disk does not hash to that, someone else
 *     changed it and the refresh declines, forever.
 *  3. **The copies that pre-date the marker are migrated ONCE, and nothing is destroyed doing
 *     it.** Rule 2 as first written declined an *unmarked* drifted copy too, which left every
 *     install made by `kelpi install-hooks` (it writes no marker) stranded on whatever bytes it
 *     had: the step could adopt an identical copy but never refresh a stale one, so the Swift's
 *     own primary case — "refresh a drifted copy" — never happened. It happens now, in the one
 *     shape that costs nothing if the guess is wrong: the drifted document is **moved aside** to
 *     `SKILL.md.bak-<stamp>` (never over an existing backup), the bundled bytes are installed,
 *     and the marker is written. That is the whole divergence from the Swift, which simply
 *     overwrites. It is one-time **by construction**: the copy it heals comes out of it marked,
 *     so the very next edit the user makes lands in rule 2 and is theirs forever.
 *
 * On top of ownership, the refresh is version-aware: when both documents declare a `version:` in
 * their front matter, an older bundled copy never replaces a newer installed one, so running an
 * old build once cannot roll a user's tooling backwards. That guard is checked BEFORE the
 * migration in rule 3 as well — an unmarked copy that declares a newer version is left where it
 * is rather than backed up and rolled back. The current document declares no version, in which
 * case "the bundle carries different bytes from the ones we installed" is the upgrade signal —
 * the same test the Swift makes, narrowed by rules 2 and 3.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BUNDLED_SKILL_NAME, packagedSkillDir } from './resources.js';

export const SKILL_FILE = 'SKILL.md';
/** Written beside the document; it is what makes "we installed this" checkable later. */
export const SKILL_MARKER_FILE = '.kelpi-skill.json';

export interface SkillFs {
    /** File contents, or `null` for "not there / not readable" — never a throw. */
    readFile(file: string): string | null;
    writeFile(file: string, contents: string): void;
    isDirectory(dir: string): boolean;
    /**
     * Anything at this path at all, readable or not — a *link* counts. This is the check that
     * makes "never overwrite an existing backup" true rather than nearly true: `readFile`
     * answers `null` for a file it merely cannot read, and treating that as free space would
     * hand the next `rename` a live file to clobber.
     */
    exists(file: string): boolean;
    /** Move, not copy: the drifted document keeps its exact bytes and mode. */
    rename(from: string, to: string): void;
}

export const nodeSkillFs: SkillFs = {
    readFile(file) {
        try {
            return fs.readFileSync(file, 'utf8');
        } catch {
            return null;
        }
    },
    writeFile(file, contents) {
        fs.writeFileSync(file, contents, 'utf8');
    },
    isDirectory(dir) {
        try {
            return fs.statSync(dir).isDirectory();
        } catch {
            return false;
        }
    },
    exists(file) {
        try {
            // `lstat`, so a dangling symlink named like a backup still counts as occupied.
            fs.lstatSync(file);
            return true;
        } catch {
            return false;
        }
    },
    rename(from, to) {
        fs.renameSync(from, to);
    }
};

export interface SkillRefreshOptions {
    /**
     * The environment `$HOME` is read from. **Required**, and the only way this module learns
     * where a home is — see the header.
     */
    readonly env: NodeJS.ProcessEnv;
    /** `process.resourcesPath` in the app; absent in a dev run, where there is no payload. */
    readonly resourcesPath?: string | undefined;
    /** Stamped into the marker so a support question can be answered from the file alone. */
    readonly appVersion?: string | undefined;
    readonly now?: (() => Date) | undefined;
}

export type SkillRefreshAction = 'installed' | 'updated' | 'unchanged' | 'skipped' | 'healed' | 'failed';

export type SkillRefreshReason =
    /** `$HOME` was empty or not absolute: there is no destination to speak of. */
    | 'no-home'
    /** This build carries no bundled document (a dev run, or a broken package). */
    | 'no-bundled-skill'
    /** The user has never installed the skill — the Swift's "never on their behalf" rule. */
    | 'not-installed'
    /** The installed copy is already the bundled one. */
    | 'identical'
    /** A marker beside the copy does not describe it: this app installed it and the user edited
     * it. Theirs, permanently — rule 2. */
    | 'user-modified'
    /**
     * A copy with NO marker beside it whose bytes differ from the bundle — the pre-marker
     * install. Backed up and replaced, once; rule 3.
     */
    | 'drifted-unmarked'
    /** The installed copy declares a version at or ahead of the bundled one. */
    | 'not-newer'
    /** The document was absent under an existing skill directory, and was written. */
    | 'absent'
    /** Ours, older, replaced. */
    | 'stale'
    /** The write threw (a read-only home, a full disk). */
    | 'write-failed'
    /**
     * The drifted copy could not be moved aside — so it was not replaced either. Nothing is
     * ever destroyed to make room for the bundle.
     */
    | 'backup-failed';

export interface SkillRefreshResult {
    readonly action: SkillRefreshAction;
    readonly reason: SkillRefreshReason;
    /** The destination document, once a home could be resolved. */
    readonly path?: string;
    readonly source?: string;
    /** Where a drifted copy was moved to, on a `healed` (or attempted on a `backup-failed`). */
    readonly backup?: string;
    readonly detail?: string;
}

/**
 * `$HOME`, or `null`.
 *
 * Deliberately not `os.homedir()` and emphatically not `app.getPath('home')`: both can answer
 * with the OS's idea of the account's home even when the process was told otherwise, which is
 * the exact failure this module was rewritten to make impossible. A relative or empty value is
 * refused rather than resolved, because a relative "home" would put the destination somewhere
 * that depends on the working directory.
 */
export function resolveHomeDirectory(env: NodeJS.ProcessEnv): string | null {
    const home = env['HOME'];
    if (typeof home !== 'string') return null;
    const trimmed = home.trim();
    if (trimmed === '' || !path.isAbsolute(trimmed)) return null;
    return trimmed;
}

/** `<home>/.claude/skills/kelpi-agentic` — where `kelpi install-hooks` puts it too. */
export function skillDestinationDir(home: string): string {
    return path.join(home, '.claude', 'skills', BUNDLED_SKILL_NAME);
}

/**
 * Where the bundled document comes from: the packaged app's `Contents/Resources/cli/skills/…`,
 * or `KELPI_SKILL_SOURCE` for a harness driving an unpackaged build — the same escape hatch
 * `--skill-source` gives the CLI, and what makes this step provable in a sandbox at all.
 */
export function bundledSkillDir(options: SkillRefreshOptions): string | null {
    const override = options.env['KELPI_SKILL_SOURCE'];
    if (typeof override === 'string' && override.trim() !== '') return override.trim();
    const resources = options.resourcesPath;
    if (typeof resources !== 'string' || resources === '') return null;
    return packagedSkillDir(resources);
}

export function hashContents(contents: string): string {
    return createHash('sha256').update(contents, 'utf8').digest('hex');
}

/**
 * The timestamp in a backup's name: ISO 8601 with the parts a filename dislikes flattened —
 * `2026-08-22T13-45-01Z`. Sortable, unambiguous, and it survives a copy to any filesystem.
 */
export function skillBackupStamp(when: Date): string {
    return when.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

/** How many same-second collisions to walk past before giving up and keeping the original. */
const MAX_BACKUP_SUFFIXES = 1000;

/**
 * `SKILL.md.bak-<stamp>`, or `…-2`, `…-3`, … — the first name in that series that nothing
 * occupies. `null` when even that runs out, which the caller must treat as "do not migrate":
 * a backup that would overwrite an earlier backup is worse than no refresh at all.
 */
export function skillBackupFile(destDir: string, stamp: string, fsys: SkillFs): string | null {
    const base = path.join(destDir, `${SKILL_FILE}.bak-${stamp}`);
    if (!fsys.exists(base)) return base;
    for (let suffix = 2; suffix <= MAX_BACKUP_SUFFIXES; suffix += 1) {
        const candidate = `${base}-${suffix}`;
        if (!fsys.exists(candidate)) return candidate;
    }
    return null;
}

/** `version:` out of a leading `---` front-matter block, when the document declares one. */
export function skillVersion(contents: string | null): string | null {
    if (contents === null) return null;
    const normalized = contents.replace(/\r\n/g, '\n');
    if (!normalized.startsWith('---\n')) return null;
    const end = normalized.indexOf('\n---', 3);
    if (end === -1) return null;
    for (const line of normalized.slice(4, end).split('\n')) {
        const match = /^version:\s*(.+?)\s*$/.exec(line);
        if (match !== null) {
            const value = (match[1] ?? '').replace(/^['"]|['"]$/g, '').trim();
            return value === '' ? null : value;
        }
    }
    return null;
}

/**
 * Dotted-numeric comparison: `1` when `a` is ahead, `-1` when behind, `0` when equal, `null`
 * when either side does not declare a version this can order (in which case the caller falls
 * back to the ownership + bytes test).
 */
export function compareSkillVersions(a: string | null, b: string | null): number | null {
    if (a === null || b === null) return null;
    const parse = (value: string): number[] | null => {
        const parts = value.split('.');
        // Every segment must be digits ALL THE WAY: `parseInt` would happily read `2026-08-21`
        // as 2026 and order a date against a version number.
        if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) return null;
        return parts.map((part) => Number.parseInt(part, 10));
    };
    const left = parse(a);
    const right = parse(b);
    if (left === null || right === null) return null;
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const l = left[index] ?? 0;
        const r = right[index] ?? 0;
        if (l !== r) return l > r ? 1 : -1;
    }
    return 0;
}

export interface SkillMarker {
    /** Hash of exactly what was written — the ownership proof. */
    readonly installedHash: string;
    /** Hash of the bundled document it came from. */
    readonly sourceHash: string;
    readonly version: string | null;
    readonly appVersion: string | null;
    readonly installedAt: string;
    readonly by: 'kelpi-shell';
}

export function parseSkillMarker(raw: string | null): SkillMarker | null {
    if (raw === null) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const record = parsed as Record<string, unknown>;
        const installedHash = record['installedHash'];
        if (typeof installedHash !== 'string' || installedHash === '') return null;
        return {
            installedHash,
            sourceHash: typeof record['sourceHash'] === 'string' ? record['sourceHash'] : '',
            version: typeof record['version'] === 'string' ? record['version'] : null,
            appVersion: typeof record['appVersion'] === 'string' ? record['appVersion'] : null,
            installedAt: typeof record['installedAt'] === 'string' ? record['installedAt'] : '',
            by: 'kelpi-shell'
        };
    } catch {
        return null;
    }
}

/** The ownership record for one installed document. */
function buildMarker(source: string, options: SkillRefreshOptions): SkillMarker {
    const hash = hashContents(source);
    return {
        installedHash: hash,
        sourceHash: hash,
        version: skillVersion(source),
        appVersion: options.appVersion ?? null,
        installedAt: (options.now?.() ?? new Date()).toISOString(),
        by: 'kelpi-shell'
    };
}

/**
 * The launch step itself. Pure decisions over an injected filesystem; the only writes it can
 * possibly make are the destination document and its marker, and it makes neither unless every
 * rule in the header says it may.
 */
export function refreshBundledSkill(options: SkillRefreshOptions, fsys: SkillFs = nodeSkillFs): SkillRefreshResult {
    const home = resolveHomeDirectory(options.env);
    if (home === null) return { action: 'skipped', reason: 'no-home' };

    const sourceDir = bundledSkillDir(options);
    if (sourceDir === null) return { action: 'skipped', reason: 'no-bundled-skill' };
    const sourceFile = path.join(sourceDir, SKILL_FILE);
    const source = fsys.readFile(sourceFile);
    if (source === null) {
        return { action: 'skipped', reason: 'no-bundled-skill', source: sourceFile };
    }

    const destDir = skillDestinationDir(home);
    const destFile = path.join(destDir, SKILL_FILE);
    // The opt-in rule, straight from the Swift: a user who never installed the skill does not
    // acquire one because they launched the app.
    if (!fsys.isDirectory(destDir)) {
        return { action: 'skipped', reason: 'not-installed', path: destFile, source: sourceFile };
    }

    const markerFile = path.join(destDir, SKILL_MARKER_FILE);
    const existing = fsys.readFile(destFile);
    if (existing === source) {
        /*
         * Nothing to copy — and the moment to ADOPT the copy that is there.
         *
         * Almost every installed copy in this port was written by `kelpi install-hooks`, which
         * leaves no ownership marker, and without one the refresh below would decline forever:
         * the step would be inert for exactly the users it is for. A document that is byte-
         * identical to the bundled one cannot have been edited relative to this build, so
         * recording the marker for it is safe, and it is what makes the KELPIT release's refresh
         * possible. Best-effort: a marker that cannot be written costs nothing today.
         */
        const adopted = parseSkillMarker(fsys.readFile(markerFile));
        if (adopted === null || adopted.installedHash !== hashContents(existing)) {
            try {
                fsys.writeFile(markerFile, `${JSON.stringify(buildMarker(source, options), null, 2)}\n`);
            } catch {
                // Leave it; the document is already current either way.
            }
        }
        return { action: 'unchanged', reason: 'identical', path: destFile, source: sourceFile };
    }

    let reason: SkillRefreshReason = 'absent';
    let backup: string | undefined;
    if (existing !== null) {
        const markerRaw = fsys.readFile(markerFile);
        const marker = parseSkillMarker(markerRaw);
        const ours = marker !== null && marker.installedHash === hashContents(existing);
        if (!ours && markerRaw !== null) {
            /*
             * Rule 2, and the branch that keeps a real home safe even when everything else about
             * the environment is wrong. There IS a marker beside this document and it does not
             * describe these bytes — this app installed it and someone has edited it since (or
             * the marker is unreadable, which is the same evidence: something wrote here and we
             * cannot prove what). Never touched again, not once, not with a backup.
             */
            return { action: 'skipped', reason: 'user-modified', path: destFile, source: sourceFile };
        }

        // The version guard runs for BOTH the marked and the unmarked case, and before the
        // migration below: a copy declaring a newer version is never rolled backwards, whoever
        // wrote it.
        const order = compareSkillVersions(skillVersion(source), skillVersion(existing));
        if (order !== null && order <= 0) {
            return { action: 'skipped', reason: 'not-newer', path: destFile, source: sourceFile };
        }

        if (ours) {
            reason = 'stale';
        } else {
            /*
             * Rule 3 — the one-time migration. Nothing beside this document says who wrote it,
             * and it is not the bundle's bytes: it is a copy `kelpi install-hooks` (or an older
             * build) left, drifted, from before this app kept receipts. It is moved aside rather
             * than overwritten, so the Swift's "refresh a drifted copy" finally happens without
             * the Swift's cost if the copy turns out to have been precious. Once, because what
             * this writes in its place carries a marker.
             */
            const candidate = skillBackupFile(destDir, skillBackupStamp(options.now?.() ?? new Date()), fsys);
            if (candidate === null) {
                return {
                    action: 'failed',
                    reason: 'backup-failed',
                    path: destFile,
                    source: sourceFile,
                    detail: 'every backup name for this timestamp is taken'
                };
            }
            try {
                fsys.rename(destFile, candidate);
            } catch (error) {
                return {
                    action: 'failed',
                    reason: 'backup-failed',
                    path: destFile,
                    source: sourceFile,
                    backup: candidate,
                    detail: error instanceof Error ? error.message : String(error)
                };
            }
            backup = candidate;
            reason = 'drifted-unmarked';
        }
    }

    try {
        fsys.writeFile(destFile, source);
        fsys.writeFile(markerFile, `${JSON.stringify(buildMarker(source, options), null, 2)}\n`);
    } catch (error) {
        // A failed write must not be how a user loses the copy that was there: put it back.
        if (backup !== undefined) {
            try {
                fsys.rename(backup, destFile);
            } catch {
                // Then the bytes are still in the backup, under their own name, and the detail
                // below is what leads a support question to them.
            }
        }
        return {
            action: 'failed',
            reason: 'write-failed',
            path: destFile,
            source: sourceFile,
            ...(backup === undefined ? {} : { backup }),
            detail: error instanceof Error ? error.message : String(error)
        };
    }
    return {
        action: reason === 'drifted-unmarked' ? 'healed' : existing === null ? 'installed' : 'updated',
        reason,
        path: destFile,
        source: sourceFile,
        ...(backup === undefined ? {} : { backup })
    };
}

/** One line for the launch log, in the shape the shell smoke greps for. */
export function describeSkillRefresh(result: SkillRefreshResult): string {
    const where = result.path === undefined ? '' : ` ${result.path}`;
    const detail = result.detail === undefined ? '' : ` — ${result.detail}`;
    // A heal names the backup rather than its reason slug: the one thing a person reading this
    // line needs is where their old document went.
    const note =
        result.action === 'healed' && result.backup !== undefined
            ? `backed up drifted copy to ${path.basename(result.backup)}`
            : result.reason;
    return `skill-refresh: ${result.action} (${note})${where}${detail}`;
}

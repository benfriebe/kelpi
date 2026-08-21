/**
 * §APP-006 — refreshing the bundled `nex-agentic` document at launch.
 *
 * The Swift app re-copies `Contents/Resources/skills/nex-agentic/SKILL.md` into
 * `~/.claude/skills/nex-agentic/` on every launch, but only when the destination directory
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
 *     changed it and the refresh declines. No marker (a copy `nex install-hooks` made, or one
 *     the user wrote) is the same answer: decline.
 *
 * On top of ownership, the refresh is version-aware: when both documents declare a `version:` in
 * their front matter, an older bundled copy never replaces a newer installed one, so running an
 * old build once cannot roll a user's tooling backwards. The current document declares no
 * version, in which case "the bundle carries different bytes from the ones we installed" is the
 * upgrade signal — the same test the Swift makes, narrowed by rule 2.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BUNDLED_SKILL_NAME, packagedSkillDir } from './resources.js';

export const SKILL_FILE = 'SKILL.md';
/** Written beside the document; it is what makes "we installed this" checkable later. */
export const SKILL_MARKER_FILE = '.nex-skill.json';

export interface SkillFs {
    /** File contents, or `null` for "not there / not readable" — never a throw. */
    readFile(file: string): string | null;
    writeFile(file: string, contents: string): void;
    isDirectory(dir: string): boolean;
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

export type SkillRefreshAction = 'installed' | 'updated' | 'unchanged' | 'skipped' | 'failed';

export type SkillRefreshReason =
    /** `$HOME` was empty or not absolute: there is no destination to speak of. */
    | 'no-home'
    /** This build carries no bundled document (a dev run, or a broken package). */
    | 'no-bundled-skill'
    /** The user has never installed the skill — the Swift's "never on their behalf" rule. */
    | 'not-installed'
    /** The installed copy is already the bundled one. */
    | 'identical'
    /** Someone other than this app wrote the installed copy. It is left exactly as it is. */
    | 'user-modified'
    /** The installed copy declares a version at or ahead of the bundled one. */
    | 'not-newer'
    /** The document was absent under an existing skill directory, and was written. */
    | 'absent'
    /** Ours, older, replaced. */
    | 'stale'
    /** The write threw (a read-only home, a full disk). */
    | 'write-failed';

export interface SkillRefreshResult {
    readonly action: SkillRefreshAction;
    readonly reason: SkillRefreshReason;
    /** The destination document, once a home could be resolved. */
    readonly path?: string;
    readonly source?: string;
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

/** `<home>/.claude/skills/nex-agentic` — where `nex install-hooks` puts it too. */
export function skillDestinationDir(home: string): string {
    return path.join(home, '.claude', 'skills', BUNDLED_SKILL_NAME);
}

/**
 * Where the bundled document comes from: the packaged app's `Contents/Resources/cli/skills/…`,
 * or `NEX_SKILL_SOURCE` for a harness driving an unpackaged build — the same escape hatch
 * `--skill-source` gives the CLI, and what makes this step provable in a sandbox at all.
 */
export function bundledSkillDir(options: SkillRefreshOptions): string | null {
    const override = options.env['NEX_SKILL_SOURCE'];
    if (typeof override === 'string' && override.trim() !== '') return override.trim();
    const resources = options.resourcesPath;
    if (typeof resources !== 'string' || resources === '') return null;
    return packagedSkillDir(resources);
}

export function hashContents(contents: string): string {
    return createHash('sha256').update(contents, 'utf8').digest('hex');
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
    readonly by: 'nex-shell';
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
            by: 'nex-shell'
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
        by: 'nex-shell'
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
         * Almost every installed copy in this port was written by `nex install-hooks`, which
         * leaves no ownership marker, and without one the refresh below would decline forever:
         * the step would be inert for exactly the users it is for. A document that is byte-
         * identical to the bundled one cannot have been edited relative to this build, so
         * recording the marker for it is safe, and it is what makes the NEXT release's refresh
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
    if (existing !== null) {
        const marker = parseSkillMarker(fsys.readFile(markerFile));
        if (marker === null || marker.installedHash !== hashContents(existing)) {
            // Rule 2. This is the branch that keeps a real home safe even when everything else
            // about the environment is wrong.
            return { action: 'skipped', reason: 'user-modified', path: destFile, source: sourceFile };
        }
        const order = compareSkillVersions(skillVersion(source), skillVersion(existing));
        if (order !== null && order <= 0) {
            return { action: 'skipped', reason: 'not-newer', path: destFile, source: sourceFile };
        }
        reason = 'stale';
    }

    try {
        fsys.writeFile(destFile, source);
        fsys.writeFile(markerFile, `${JSON.stringify(buildMarker(source, options), null, 2)}\n`);
    } catch (error) {
        return {
            action: 'failed',
            reason: 'write-failed',
            path: destFile,
            source: sourceFile,
            detail: error instanceof Error ? error.message : String(error)
        };
    }
    return {
        action: existing === null ? 'installed' : 'updated',
        reason,
        path: destFile,
        source: sourceFile
    };
}

/** One line for the launch log, in the shape the shell smoke greps for. */
export function describeSkillRefresh(result: SkillRefreshResult): string {
    const where = result.path === undefined ? '' : ` ${result.path}`;
    const detail = result.detail === undefined ? '' : ` — ${result.detail}`;
    return `skill-refresh: ${result.action} (${result.reason})${where}${detail}`;
}

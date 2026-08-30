/**
 * The bundled `nex-agentic` Claude Code skill (CLI-146).
 *
 * `install-hooks.sh` copied `Contents/Resources/skills/nex-agentic/SKILL.md` into
 * `~/.claude/skills/nex-agentic/` whenever the app bundle carried one, and `CLIInstallService`
 * re-copied it on launch when the contents had drifted. Both halves exist here: this module is
 * the copy, `kelpi install-hooks` runs it, and the file lives in `packages/cli/resources/` so a
 * checkout has it too — the CLI is the artifact that ships the skill now, not the app.
 *
 * The skill teaches an agent to drive `kelpi` itself (spawn worker panes, fan work out, read a
 * pane's output back, drive the web pane). It is a *document*, so "installing" it is one file
 * copy, and an unchanged copy is reported rather than rewritten — the same `unchanged` discipline
 * the hook files get, and for the same reason: a re-run should be able to say it did nothing.
 *
 * Where the source comes from, in order:
 *   1. `--skill-source <dir>` — a directory containing `SKILL.md` (what the tests use);
 *   2. `<dir of the running bundle>/skills/nex-agentic` — the packaged app's
 *      `Contents/Resources/cli/skills/…`, staged beside `kelpi.js`;
 *   3. `<bundle dir>/../resources/skills/nex-agentic` — a workspace checkout, where the bundle is
 *      `packages/cli/dist/kelpi.js` and the resource sits at `packages/cli/resources/…`.
 *
 * None of them found means "this build carries no skill", which is a skip and not an error — the
 * shell script behaved the same way (`if [ -d "$SKILL_SRC" ]`).
 */

import path from 'node:path';

import type { InstallFs } from './fs.js';

export const SKILL_NAME = 'nex-agentic';
export const SKILL_FILE = 'SKILL.md';

export type SkillAction = 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed';

export interface SkillOutcome {
    readonly action: SkillAction;
    /** Where it went (`<claude-dir>/skills/nex-agentic/SKILL.md`). */
    readonly path: string;
    /** Where it came from, when one was found. */
    readonly source?: string;
    readonly reason?: string;
}

export interface SkillOptions {
    readonly claudeDir: string;
    /** `--skill-source`, a directory holding `SKILL.md`. */
    readonly source?: string | undefined;
    /** The running CLI bundle, for the two derived locations. */
    readonly executable?: string | null | undefined;
    readonly dryRun: boolean;
}

/**
 * Candidate source directories.
 *
 * `--skill-source` is exclusive, not merely first: a caller who names a directory and gets the
 * copy from somewhere else has been lied to. Without it, the two derived locations are tried in
 * order (packaged app, then checkout).
 */
export function skillSourceCandidates(options: SkillOptions): string[] {
    if (options.source !== undefined && options.source.length > 0) return [options.source];
    const candidates: string[] = [];
    const executable = options.executable;
    if (executable !== null && executable !== undefined && executable.length > 0) {
        const dir = path.dirname(executable);
        candidates.push(path.join(dir, 'skills', SKILL_NAME));
        candidates.push(path.join(dir, '..', 'resources', 'skills', SKILL_NAME));
    }
    return candidates;
}

/** The first candidate that actually holds a readable `SKILL.md`. */
export function findBundledSkill(options: SkillOptions, fsys: InstallFs): { dir: string; contents: string } | null {
    for (const dir of skillSourceCandidates(options)) {
        const contents = fsys.readFile(path.join(dir, SKILL_FILE));
        if (contents !== null) return { dir, contents };
    }
    return null;
}

export function installSkill(options: SkillOptions, fsys: InstallFs): SkillOutcome {
    const destDir = path.join(options.claudeDir, 'skills', SKILL_NAME);
    const destFile = path.join(destDir, SKILL_FILE);

    const found = findBundledSkill(options, fsys);
    if (found === null) {
        return { action: 'skipped', path: destFile, reason: 'this build carries no bundled skill' };
    }

    const existing = fsys.readFile(destFile);
    if (existing === found.contents) {
        return { action: 'unchanged', path: destFile, source: path.join(found.dir, SKILL_FILE) };
    }
    if (options.dryRun) {
        return {
            action: existing === null ? 'created' : 'updated',
            path: destFile,
            source: path.join(found.dir, SKILL_FILE)
        };
    }
    try {
        fsys.mkdirp(destDir);
        fsys.writeFile(destFile, found.contents);
        return {
            action: existing === null ? 'created' : 'updated',
            path: destFile,
            source: path.join(found.dir, SKILL_FILE)
        };
    } catch (error) {
        return {
            action: 'failed',
            path: destFile,
            source: path.join(found.dir, SKILL_FILE),
            reason: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * `kelpi install-hooks` — the port of `scripts/install-hooks.sh`'s two hook sections
 * (CLI-145, CLI-147, AGNT-123, AGNT-124).
 *
 * The shell script's shape, kept:
 *
 *   - **Claude Code first, and it is the one that can fail the run.** `mkdir -p ~/.claude`, then
 *     create `settings.json` when absent (`json.dump(..., indent=2)`) or merge into it when it
 *     exists. A malformed existing file aborted the script (`set -e` on the Python's
 *     `json.load`); here it is a typed failure with a repair line, and **nothing is written**.
 *   - **Codex last, and non-fatal.** It runs only when `~/.codex` exists (Codex CLI ≥ 0.142 is
 *     what has hooks at all); a bad `hooks.json` prints a warning and leaves the Claude hooks —
 *     the installer's primary job, already done — untouched. The one-time `/hooks` trust note is
 *     printed whenever the section runs, because hook *trust* is not inspectable from out here.
 *
 * Two things this adds to the shell script, both because a CLI is re-run more casually than a
 * script someone downloads:
 *
 *   - **A backup before the first write.** `<file>.kelpi-backup` is a copy of the bytes that were
 *     there, taken only when an existing file is actually about to change. A refusal (malformed
 *     JSON) writes nothing at all, so a backup from an earlier good run stays intact.
 *   - **`unchanged` instead of a rewrite.** The merge is idempotent, so a re-run that produces
 *     identical bytes reports `unchanged` and skips both the write and the backup. That makes
 *     "did the installer change anything?" answerable by a script (`--json`) rather than by
 *     diffing mtimes.
 *
 * `--dry-run` runs the whole thing and writes nothing, carrying the merged bytes back as
 * `preview` so a caller can diff before committing.
 */

import { parseJsonObject, type JsonObject } from '../json.js';
import type { InstallFs } from './fs.js';
import { mergeHooks, renderHookFile } from './merge.js';
import { installSkill, type SkillOutcome } from './skill.js';
import { CLAUDE_HOOK_WIRINGS, CODEX_HOOK_WIRINGS, canonicalBases, hookPayload } from './spec.js';

/** Suffix of the pre-write copy. Deterministic on purpose: a timestamped name is unfindable. */
export const BACKUP_SUFFIX = '.kelpi-backup';

export const CODEX_TRUST_NOTE =
    'Codex requires one-time hook trust — run /hooks inside codex to trust the kelpi hooks (repeat whenever hooks.json changes). Requires Codex CLI >= 0.142.';

export type InstallAction = 'created' | 'merged' | 'unchanged' | 'skipped' | 'failed';

export interface TargetOutcome {
    readonly agent: 'claude' | 'codex';
    readonly path: string;
    readonly action: InstallAction;
    /** Why it was skipped or how it failed. */
    readonly reason?: string;
    /** Where the pre-write copy went (absent for a create / unchanged / dry run). */
    readonly backup?: string;
    /** The bytes that were (or would be) written. */
    readonly preview?: string;
}

export interface InstallHooksResult {
    /** False only when the CLAUDE half failed — Codex problems are warnings by design. */
    readonly ok: boolean;
    readonly dryRun: boolean;
    /** The command prefix baked into every hook. */
    readonly command: string;
    readonly claude: TargetOutcome;
    readonly codex: TargetOutcome;
    /** The bundled `nex-agentic` skill (`./skill.ts`); `skipped` when the build has none. */
    readonly skill: SkillOutcome;
    readonly warnings: readonly string[];
    readonly notes: readonly string[];
}

export interface InstallHooksOptions {
    /** Claude Code's config directory (`~/.claude`). */
    readonly claudeDir: string;
    /** Codex CLI's config directory (`~/.codex`). */
    readonly codexDir: string;
    /** What the hooks will invoke — `kelpi`, or an absolute path. See `./self.ts`. */
    readonly commandPrefix: string;
    readonly dryRun: boolean;
    /** `--skill-source`: a directory holding the `nex-agentic` SKILL.md. */
    readonly skillSource?: string | undefined;
    /** The running CLI bundle, so the skill can be found beside it. */
    readonly executable?: string | null | undefined;
}

interface WriteTarget {
    readonly agent: 'claude' | 'codex';
    readonly dir: string;
    readonly file: string;
    readonly payload: JsonObject;
    readonly bases: readonly string[];
}

function joinPath(dir: string, name: string): string {
    return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/**
 * Merge (or create) one hook file. Pure decision + at most two writes, so both agents share it.
 */
function installOne(target: WriteTarget, fsys: InstallFs, dryRun: boolean): TargetOutcome {
    const existing = fsys.readFile(target.file);

    let settings: JsonObject;
    if (existing === null) {
        settings = {};
    } else {
        const parsed = parseJsonObject(existing);
        if (parsed === null) {
            return {
                agent: target.agent,
                path: target.file,
                action: 'failed',
                reason: `${target.file} is not valid JSON — refusing to overwrite it. Fix or move the file, then re-run.`
            };
        }
        settings = parsed;
    }

    const contents = renderHookFile(mergeHooks(settings, target.payload, target.bases));

    if (existing === contents) {
        return { agent: target.agent, path: target.file, action: 'unchanged', preview: contents };
    }
    if (dryRun) {
        return {
            agent: target.agent,
            path: target.file,
            action: existing === null ? 'created' : 'merged',
            preview: contents
        };
    }

    try {
        fsys.mkdirp(target.dir);
        let backup: string | undefined;
        if (existing !== null) {
            backup = `${target.file}${BACKUP_SUFFIX}`;
            fsys.copyFile(target.file, backup);
        }
        fsys.writeFile(target.file, contents);
        return {
            agent: target.agent,
            path: target.file,
            action: existing === null ? 'created' : 'merged',
            ...(backup === undefined ? {} : { backup }),
            preview: contents
        };
    } catch (error) {
        return {
            agent: target.agent,
            path: target.file,
            action: 'failed',
            reason: error instanceof Error ? error.message : String(error)
        };
    }
}

export function installHooks(options: InstallHooksOptions, fsys: InstallFs): InstallHooksResult {
    const warnings: string[] = [];
    const notes: string[] = [];

    const claude = installOne(
        {
            agent: 'claude',
            dir: options.claudeDir,
            file: joinPath(options.claudeDir, 'settings.json'),
            payload: hookPayload(CLAUDE_HOOK_WIRINGS, options.commandPrefix),
            bases: canonicalBases(CLAUDE_HOOK_WIRINGS)
        },
        fsys,
        options.dryRun
    );

    // The bundled skill, between the two hook sections exactly as in the shell script. It is
    // never fatal: a skill that could not be copied costs an agent some documentation, where a
    // failed Claude hook install costs every pane its status.
    const skill = installSkill(
        {
            claudeDir: options.claudeDir,
            source: options.skillSource,
            executable: options.executable,
            dryRun: options.dryRun
        },
        fsys
    );
    if (skill.action === 'failed') {
        warnings.push(`could not install the nex-agentic skill (${skill.reason ?? 'unknown error'}).`);
    }

    // §"Configure Codex CLI hooks": last, and only when the directory is there. An absent
    // ~/.codex means Codex CLI is not installed, which is a skip and not a problem.
    let codex: TargetOutcome;
    if (!fsys.isDirectory(options.codexDir)) {
        codex = {
            agent: 'codex',
            path: joinPath(options.codexDir, 'hooks.json'),
            action: 'skipped',
            reason: `no ${options.codexDir} — Codex CLI not detected`
        };
    } else {
        codex = installOne(
            {
                agent: 'codex',
                dir: options.codexDir,
                file: joinPath(options.codexDir, 'hooks.json'),
                payload: hookPayload(CODEX_HOOK_WIRINGS, options.commandPrefix),
                bases: canonicalBases(CODEX_HOOK_WIRINGS)
            },
            fsys,
            options.dryRun
        );
        if (codex.action === 'failed') {
            warnings.push(
                `could not write Codex hooks (${codex.reason ?? 'unknown error'}). Skipping Codex hooks — the Claude Code hooks above are unaffected.`
            );
        } else {
            notes.push(CODEX_TRUST_NOTE);
        }
    }

    return {
        ok: claude.action !== 'failed',
        dryRun: options.dryRun,
        command: options.commandPrefix,
        claude,
        codex,
        skill,
        warnings,
        notes
    };
}

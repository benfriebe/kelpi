/**
 * Doctor checks 6 and 7 — the Claude Code and Codex hook configs (cli.md §16.6/§16.7).
 *
 * These are LOCAL filesystem reads and stay that way in the daemon world (port note 16): they
 * inspect the machine where the agent CLIs run, which is where hooks fire, not where the
 * daemon lives. Drift is always WARN, never FAIL — IPC is healthy; what degrades is agent
 * status and session-id binding.
 *
 * The subtle one is SessionStart matcher coverage: a pre-v0.19 installer wrote
 * `"matcher": "startup"`, and app updates never rewrite `~/.claude/settings.json`, so those
 * installs silently never bind a session id for `claude --continue` / `--resume` (issue #181).
 * `matcherCovers` implements Claude Code's documented three-way matcher semantics so doctor
 * can see that.
 */

import type { JsonObject } from '../json.js';
import { parseJsonObject } from '../json.js';
import type { DoctorCheck } from './types.js';

export const expectedHooks: readonly (readonly [string, string])[] = [
    ['Stop', 'nex event stop'],
    ['Notification', 'nex event notification'],
    ['SessionStart', 'nex event session-start'],
    ['SessionEnd', 'nex event session-end'],
    ['UserPromptSubmit', 'nex event start']
];

export const expectedCodexHooks: readonly (readonly [string, string])[] = [
    ['Stop', 'nex event stop --agent codex'],
    ['PermissionRequest', 'nex event notification --agent codex'],
    ['SessionStart', 'nex event session-start --agent codex'],
    ['UserPromptSubmit', 'nex event start --agent codex']
];

export const sessionStartSources: readonly string[] = ['startup', 'resume', 'clear', 'compact'];

const HOOKS_REPAIR =
    'Re-run the bundled installer (safe to re-run — it merges, dedupes, and normalises nex-managed hooks): /Applications/Nex.app/Contents/Resources/scripts/install-hooks.sh';
const CODEX_REPAIR =
    'Re-run the bundled installer (/Applications/Nex.app/Contents/Resources/scripts/install-hooks.sh), then run /hooks inside codex once to trust the nex hooks.';

export interface HookFilesystem {
    /** File contents, or null when absent/unreadable. */
    readFile(path: string): string | null;
    isDirectory(path: string): boolean;
}

/** Claude Code's matcher semantics: `*`/empty = all; a `|`/`,` list; else an unanchored regex. */
export function matcherCovers(matcher: string, source: string): boolean {
    const trimmed = matcher.trim();
    if (trimmed.length === 0 || trimmed === '*') return true;
    if (/^[A-Za-z0-9_\-, |]*$/.test(trimmed)) {
        return trimmed
            .split(/[|,]/)
            .map((entry) => entry.trim())
            .includes(source);
    }
    try {
        return new RegExp(trimmed).test(source);
    } catch {
        // A pattern Claude Code could not compile would never fire either.
        return false;
    }
}

function groupsUnder(files: readonly JsonObject[], event: string): JsonObject[] {
    const groups: JsonObject[] = [];
    for (const file of files) {
        const hooks = file['hooks'];
        if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) continue;
        const list = (hooks as JsonObject)[event];
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) groups.push(entry);
        }
    }
    return groups;
}

/** Groups whose inner command list CONTAINS `command` as a substring (paths, flags count). */
function groupsWiring(files: readonly JsonObject[], event: string, command: string): JsonObject[] {
    return groupsUnder(files, event).filter((group) => {
        const inner = group['hooks'];
        if (!Array.isArray(inner)) return false;
        return inner.some((hook) => {
            if (typeof hook !== 'object' || hook === null || Array.isArray(hook)) return false;
            const value = (hook as JsonObject)['command'];
            return typeof value === 'string' && value.includes(command);
        });
    });
}

export function claudeHooksCheck(fsys: HookFilesystem, home: string, label = '~/.claude'): DoctorCheck {
    const dir = `${home}/.claude`;
    const fileNames = ['settings.json', 'settings.local.json'];
    const parsed: { name: string; json: JsonObject }[] = [];
    const unreadable: string[] = [];
    for (const name of fileNames) {
        const raw = fsys.readFile(`${dir}/${name}`);
        if (raw === null) continue;
        const json = parseJsonObject(raw);
        if (json === null) unreadable.push(name);
        else parsed.push({ name, json });
    }

    if (parsed.length === 0 && unreadable.length === 0) {
        if (fsys.isDirectory(dir)) {
            return {
                name: 'hooks',
                status: 'WARN',
                detail: `no Claude Code settings in ${label} — nex hooks are not installed, so agent status and session ids won't track.`,
                repair: HOOKS_REPAIR
            };
        }
        return {
            name: 'hooks',
            status: 'SKIP',
            detail: `skipped (no ${label} directory — Claude Code not detected)`
        };
    }

    const problems: string[] = [];
    if (unreadable.length > 0) {
        problems.push(`not valid JSON: ${unreadable.join(', ')} (Claude Code itself needs these parseable)`);
    }

    const files = parsed.map((entry) => entry.json);
    // Last file that defines it wins (local overrides user).
    const disableAll = [...files].reverse().map((file) => file['disableAllHooks']).find((value) => typeof value === 'boolean');
    if (disableAll === true) {
        problems.push(
            '"disableAllHooks": true is set — every hook (including nex\'s) is disabled, so session ids and agent status won\'t track'
        );
    }

    const missing = expectedHooks
        .filter(([event, command]) => groupsWiring(files, event, command).length === 0)
        .map(([event, command]) => `${event} → \`${command}\``);
    if (missing.length > 0) problems.push(`missing hook(s): ${missing.join(', ')}`);

    const sessionStartGroups = groupsWiring(files, 'SessionStart', 'nex event session-start');
    if (sessionStartGroups.length > 0) {
        const matchers = sessionStartGroups.map((group) => {
            const value = group['matcher'];
            return typeof value === 'string' ? value : null;
        });
        const uncovered = sessionStartSources.filter(
            (source) => !matchers.some((matcher) => matcher === null || matcherCovers(matcher, source))
        );
        if (uncovered.length > 0) {
            const resumeTail = uncovered.includes('resume')
                ? ' — resumed sessions (`claude --continue` / `--resume`) won\'t bind their session id (issue #181)'
                : '';
            const rendered = matchers
                .filter((matcher): matcher is string => matcher !== null)
                .map((matcher) => `"${matcher}"`)
                .join(', ');
            problems.push(`SessionStart matcher ${rendered} misses source(s): ${uncovered.join(', ')}${resumeTail}`);
        }
    }

    const scope = parsed.map((entry) => entry.name).join(', ');
    if (problems.length === 0) {
        return { name: 'hooks', status: 'PASS', detail: `all nex hooks wired in ${label} (checked ${scope})` };
    }
    return {
        name: 'hooks',
        status: 'WARN',
        detail: `hook config drift in ${label} (checked ${scope}; project-level settings scopes not checked): ${problems.join('; ')}`,
        repair: HOOKS_REPAIR
    };
}

export function codexHooksCheck(fsys: HookFilesystem, home: string, label = '~/.codex'): DoctorCheck {
    const dir = `${home}/.codex`;
    if (!fsys.isDirectory(dir)) {
        return {
            name: 'codex-hooks',
            status: 'SKIP',
            detail: `skipped (no ${label} directory — Codex CLI not detected)`
        };
    }
    const raw = fsys.readFile(`${dir}/hooks.json`);
    if (raw === null) {
        return {
            name: 'codex-hooks',
            status: 'WARN',
            detail: `no hooks.json in ${label} — nex Codex hooks are not installed, so Codex panes won't track status or session ids (needs Codex CLI ≥ 0.142).`,
            repair: CODEX_REPAIR
        };
    }
    const json = parseJsonObject(raw);
    if (json === null) {
        return {
            name: 'codex-hooks',
            status: 'WARN',
            detail: `${label}/hooks.json is not valid JSON (Codex itself needs it parseable).`,
            repair: CODEX_REPAIR
        };
    }

    const missing = expectedCodexHooks
        .filter(([event, command]) => groupsWiring([json], event, command).length === 0)
        .map(([event, command]) => `${event} → \`${command}\``);
    if (missing.length === 0) {
        return {
            name: 'codex-hooks',
            status: 'PASS',
            detail: `all nex Codex hooks wired in ${label}/hooks.json (trust state not verifiable — run /hooks inside codex if they don't fire; inline [hooks] in config.toml not checked)`
        };
    }
    return {
        name: 'codex-hooks',
        status: 'WARN',
        detail: `Codex hook config drift in ${label}/hooks.json (inline [hooks] in config.toml not checked): missing hook(s): ${missing.join(', ')}`,
        repair: CODEX_REPAIR
    };
}

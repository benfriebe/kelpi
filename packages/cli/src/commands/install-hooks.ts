/**
 * `kelpi install-hooks [--claude-dir <dir>] [--codex-dir <dir>] [--link] [--dry-run] [--json]`
 *
 * The port's replacement for `/Applications/Nex.app/Contents/Resources/scripts/install-hooks.sh`
 * (gap #1). It is what `kelpi doctor`'s two hook checks now name as the repair, so the two halves
 * — the checker and the fixer — finally ship in the same artifact.
 *
 * Stream discipline (`../io.ts` rule 1): the progress lines are DATA about what was written, so
 * they go to stdout; `Warning:` lines go to stderr. `--json` prints one object and nothing else,
 * so a script can read it without filtering.
 *
 * Exit code follows the Claude half only. Codex is best-effort by design (CLI-147): a machine
 * with a broken `~/.codex/hooks.json` still gets working Claude Code hooks, and says so.
 */

import { hasHelpFlag, parseFlag, popSwitch, rejectLeftoverArgs } from '../args.js';
import { env, envValue, homeDirectory } from '../env.js';
import { errLine, exit, printLine, writeErr } from '../io.js';
import { stableStringify, type JsonObject, type JsonValue } from '../json.js';
import { nodeInstallFs } from '../install/fs.js';
import { installHooks, type InstallHooksResult, type TargetOutcome } from '../install/hooks.js';
import { DEFAULT_INSTALL_DIR, linkCli, type LinkResult } from '../install/link.js';
import { resolveHookCommand } from '../install/self.js';
import type { SkillOutcome } from '../install/skill.js';
import { installHooksUsage } from '../usage.js';

function outcomeJSON(outcome: TargetOutcome): JsonObject {
    const json: JsonObject = { path: outcome.path, action: outcome.action };
    if (outcome.reason !== undefined) json['reason'] = outcome.reason;
    if (outcome.backup !== undefined) json['backup'] = outcome.backup;
    return json;
}

function skillJSON(skill: SkillOutcome): JsonObject {
    const json: JsonObject = { path: skill.path, action: skill.action };
    if (skill.source !== undefined) json['source'] = skill.source;
    if (skill.reason !== undefined) json['reason'] = skill.reason;
    return json;
}

function linkJSON(link: LinkResult): JsonObject {
    const json: JsonObject = {
        path: link.path,
        target: link.target,
        action: link.action,
        ok: link.ok,
        on_path: link.onPath,
        manual_command: link.manualCommand
    };
    if (link.reason !== undefined) json['reason'] = link.reason;
    return json;
}

function describe(outcome: TargetOutcome, dryRun: boolean): string {
    const would = dryRun ? 'would be ' : '';
    switch (outcome.action) {
        case 'created':
            return `  ${would}created ${outcome.path}`;
        case 'merged':
            return `  ${would}merged into ${outcome.path}${outcome.backup === undefined ? '' : ` (backup: ${outcome.backup})`}`;
        case 'unchanged':
            return `  ${outcome.path} already up to date`;
        case 'skipped':
            return `  skipped ${outcome.path} (${outcome.reason ?? 'not applicable'})`;
        case 'failed':
            return `  FAILED ${outcome.path}: ${outcome.reason ?? 'unknown error'}`;
    }
}

export function handleInstallHooks(args: string[]): void {
    if (hasHelpFlag(args)) {
        printLine(installHooksUsage.trimEnd());
        exit(0);
    }

    const asJSON = popSwitch('--json', args);
    const dryRun = popSwitch('--dry-run', args);
    const link = popSwitch('--link', args);
    const claudeDirFlag = parseFlag('--claude-dir', args);
    const codexDirFlag = parseFlag('--codex-dir', args);
    const commandFlag = parseFlag('--command', args);
    const installDirFlag = parseFlag('--install-dir', args);
    const skillSourceFlag = parseFlag('--skill-source', args);
    rejectLeftoverArgs(args, 'kelpi install-hooks', {
        positionalHint: 'this command takes options only',
        usage: (write) => {
            write(installHooksUsage);
        }
    });

    const home = homeDirectory();
    const claudeDir = claudeDirFlag ?? `${home}/.claude`;
    const codexDir = codexDirFlag ?? `${home}/.codex`;
    // `KELPI_INSTALL_DIR` is the same override the shell installer honoured.
    const installDir = installDirFlag ?? envValue('KELPI_INSTALL_DIR') ?? DEFAULT_INSTALL_DIR;
    const pathValue = env()['PATH'];

    const self = resolveHookCommand(
        { override: commandFlag ?? undefined, argv: process.argv, pathValue },
        nodeInstallFs
    );

    // --link runs FIRST when asked for: linking may be what puts `kelpi` on PATH, and the hook
    // command is chosen after, so a fresh machine gets the bare `kelpi` on its very first run.
    let linkResult: LinkResult | null = null;
    if (link) {
        if (self.executable === null) {
            errLine('kelpi install-hooks: cannot resolve this CLI\'s own path, so there is nothing to link.');
            exit(1);
        }
        linkResult = linkCli({ installDir, target: self.executable, pathValue, dryRun }, nodeInstallFs);
    }
    const command =
        commandFlag ?? (linkResult !== null && linkResult.ok && linkResult.onPath ? 'kelpi' : self.command);

    const result: InstallHooksResult = installHooks(
        {
            claudeDir,
            codexDir,
            commandPrefix: command,
            dryRun,
            skillSource: skillSourceFlag ?? undefined,
            executable: self.executable
        },
        nodeInstallFs
    );

    if (asJSON) {
        const json: JsonObject = {
            ok: result.ok && (linkResult === null || linkResult.ok),
            dry_run: dryRun,
            command,
            claude: outcomeJSON(result.claude),
            codex: outcomeJSON(result.codex),
            skill: skillJSON(result.skill),
            warnings: [...result.warnings] as JsonValue,
            notes: [...result.notes] as JsonValue
        };
        if (linkResult !== null) json['link'] = linkJSON(linkResult);
        printLine(stableStringify(json));
        exit(result.ok && (linkResult === null || linkResult.ok) ? 0 : 1);
    }

    if (linkResult !== null) {
        if (linkResult.action === 'failed') {
            writeErr(`Warning: could not install the CLI symlink — ${linkResult.reason ?? 'unknown error'}\n`);
            writeErr(`Repair: run it yourself:\n  ${linkResult.manualCommand}\n`);
        } else if (linkResult.action === 'unchanged') {
            printLine(`  ${linkResult.path} already points at ${linkResult.target}`);
        } else {
            printLine(
                `  ${dryRun ? 'would link' : 'linked'} ${linkResult.path} -> ${linkResult.target}`
            );
        }
        if (!linkResult.onPath) {
            writeErr(
                `Warning: ${installDir} is not on this shell's PATH. The hooks run bare 'kelpi' commands,\n` +
                    '  so they would fail in shells that cannot find it.\n'
            );
        }
    }

    printLine(`Configuring Claude Code hooks (command: ${command})...`);
    printLine(describe(result.claude, dryRun));
    switch (result.skill.action) {
        case 'skipped':
            break; // no bundled skill in this build: nothing to say
        case 'unchanged':
            printLine(`  nex-agentic skill already up to date (${result.skill.path})`);
            break;
        case 'failed':
            break; // reported as a warning below
        default:
            printLine(
                `  ${dryRun ? 'would install' : 'installed'} the nex-agentic skill to ${result.skill.path}`
            );
    }
    if (result.codex.action === 'skipped') {
        printLine(`Skipping Codex CLI hooks (${result.codex.reason ?? 'not applicable'}).`);
    } else {
        printLine('Configuring Codex CLI hooks...');
        printLine(describe(result.codex, dryRun));
    }
    for (const note of result.notes) printLine(`  Note: ${note}`);
    for (const warning of result.warnings) writeErr(`Warning: ${warning}\n`);

    if (!result.ok) {
        errLine('');
        errLine(`Error: ${result.claude.reason ?? 'the Claude Code hooks could not be written.'}`);
        exit(1);
    }

    printLine('');
    printLine(
        dryRun
            ? 'Dry run: nothing was written. Re-run without --dry-run to apply.'
            : 'Done. Restart any running agent sessions to pick up the new hooks.'
    );
    if (!dryRun) {
        // Routing, in one line: hooks run a bare `kelpi`, and inside Kelpi panes that resolves
        // and routes automatically (the pane env carries the bundled CLI on PATH plus an
        // injected NEX_SOCKET) — the shared default socket only matters in plain terminals.
        printLine(
            'Inside Kelpi panes, hook routing is automatic; the default /tmp/nex.sock only matters for plain terminals.'
        );
    }
    exit(0);
}

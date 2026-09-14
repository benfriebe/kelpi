import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cliUsageRefusal } from './stack.mjs';

/**
 * The invocations the harness spells out, and what happens when it spells one wrong (#202).
 *
 * `poster-swap` cleaned up with `workspace delete --name poster-swap --force`. The CLI takes
 * POSITIONAL names or ids there and rejects any leading-dash token it does not know, while the
 * sibling `workspace create` three lines earlier in the same step DOES take `--name`. The call
 * exited 1 into a `cli.run` result nobody read, the workspace stayed active for the next 28 steps
 * and blanked four of them, and no report said a word about it.
 *
 * Two rules keep that from coming back: no source in the harness may pass `workspace delete` a
 * flag the CLI does not accept, and the CLI's own "I could not parse that" answers must throw out
 * of `cli.run` rather than resolve. Both are checked here, off a window and off a daemon.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/** Exactly what `workspace delete` pops before it refuses the rest (`workspace.ts:194-207`). */
const DELETE_FLAGS = ['--force', '-y', '--prune-worktree', '--json'];

const harnessSources = () => {
    const dirs = [
        path.join(repoRoot, 'scripts'),
        path.join(repoRoot, 'scripts', 'ui-audit'),
        path.join(repoRoot, 'scripts', 'ui-audit', 'lib'),
        path.join(repoRoot, 'scripts', 'scenarios')
    ];
    const files = [];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const entry of fs.readdirSync(dir)) {
            if (entry.endsWith('.mjs')) files.push(path.join(dir, entry));
        }
    }
    return files;
};

/** Every `['workspace', 'delete', …]` argv literal in a source, as its quoted tokens. */
const deleteInvocations = (source) => {
    const found = [];
    const pattern = /\[\s*'workspace',\s*'delete'([^\]]*)\]/g;
    for (const match of source.matchAll(pattern)) {
        found.push({
            text: `['workspace', 'delete'${match[1]}]`,
            tokens: [...match[1].matchAll(/'([^']*)'/g)].map((token) => token[1])
        });
    }
    return found;
};

describe('workspace delete, as the harness spells it', () => {
    it('never passes a flag the CLI refuses', () => {
        const offenders = [];
        let seen = 0;
        for (const file of harnessSources()) {
            for (const call of deleteInvocations(fs.readFileSync(file, 'utf8'))) {
                seen += 1;
                for (const token of call.tokens) {
                    if (token.startsWith('-') && !DELETE_FLAGS.includes(token)) {
                        offenders.push(`${path.relative(repoRoot, file)}: ${call.text}`);
                    }
                }
            }
        }
        // The scan has to be reading something: an argv literal that stops matching the pattern
        // would otherwise turn this into a test that passes by finding nothing.
        expect(seen).toBeGreaterThanOrEqual(10);
        expect(offenders).toEqual([]);
    });

    it('and every delete names its workspace positionally', () => {
        const audit = fs.readFileSync(path.join(repoRoot, 'scripts', 'ui-audit', 'audit.mjs'), 'utf8');
        // Asserted on the boolean rather than the text, so a regression reports itself in one line
        // instead of diffing 2.2 MB of audit into the terminal.
        expect(audit.includes("'workspace', 'delete', '--name'")).toBe(false);
        const scratch = deleteInvocations(audit).filter(
            (call) => call.text.includes('workspaceName') || call.text.includes('target')
        );
        // Both of the file's scratch-workspace cleanups: `web-popup-layering`'s, which was already
        // positional and already checked, and `poster-swap`'s, which now deletes by id.
        expect(scratch.length).toBeGreaterThanOrEqual(2);
        for (const call of scratch) expect(call.tokens.filter((token) => token.startsWith('-'))).toEqual(['--force']);
    });

    it('and poster-swap deletes the id its create reported, not a name that may not be unique', () => {
        const audit = fs.readFileSync(path.join(repoRoot, 'scripts', 'ui-audit', 'audit.mjs'), 'utf8');
        expect(audit).toContain("const target = workspaceID ?? workspaceName;");
        expect(audit).toContain("await cli.run(['workspace', 'delete', target, '--force']");
    });

    it('keeps the accepted set in step with the CLI', () => {
        const source = fs.readFileSync(path.join(repoRoot, 'packages', 'cli', 'src', 'commands', 'workspace.ts'), 'utf8');
        const usage = /Usage: kelpi workspace delete[^'`\n]*/.exec(source);
        expect(usage).not.toBeNull();
        for (const flag of DELETE_FLAGS) expect(usage[0]).toContain(flag);
        expect(usage[0]).not.toContain('--name');
    });
});

describe('cliUsageRefusal', () => {
    it('catches the refusal #202 rode in on', () => {
        expect(
            cliUsageRefusal({
                code: 1,
                stdout: '',
                stderr:
                    'Unknown option for workspace delete: --name\n' +
                    'Usage: kelpi workspace delete <name-or-id> [<name-or-id> ...] [--force|-y] [--prune-worktree] [--json]\n'
            })
        ).toBe('Unknown option for workspace delete: --name');
    });

    it('catches an unknown command and an unknown action', () => {
        expect(cliUsageRefusal({ code: 1, stdout: '', stderr: 'Unknown command: worspace\n' })).toBe(
            'Unknown command: worspace'
        );
        expect(cliUsageRefusal({ code: 1, stdout: '', stderr: 'Unknown workspace action: delet\n' })).toBe(
            'Unknown workspace action: delet'
        );
    });

    it('catches the form every other command refuses with (rejectLeftoverArgs)', () => {
        expect(
            cliUsageRefusal({
                code: 1,
                stdout: '',
                stderr: 'kelpi pane capture: unknown option --nmae\nUsage: kelpi pane capture <pane-id> [--lines N]\n'
            })
        ).toBe('kelpi pane capture: unknown option --nmae');
        // The label is bare at some call sites and `kelpi `-prefixed at others.
        expect(cliUsageRefusal({ code: 1, stdout: '', stderr: "pane resize: unexpected argument 'sideways'\n" })).toBe(
            "pane resize: unexpected argument 'sideways'"
        );
        expect(cliUsageRefusal({ code: 1, stdout: '', stderr: 'workspace move: unknown option --to\n' })).toBe(
            'workspace move: unknown option --to'
        );
    });

    it('reads stderr only, so a captured scrollback cannot be mistaken for a misspelt invocation', () => {
        expect(cliUsageRefusal({ code: 1, stdout: '$ worspace\nUnknown command: worspace\n', stderr: '' })).toBeNull();
    });

    it('reads the FIRST line, so a relayed daemon or plugin message cannot trip it', () => {
        // `web.ts` and `plugin.ts` relay arbitrary multi-line text to the same stream; only the
        // first line of stderr is ever the CLI's own parse refusal.
        expect(
            cliUsageRefusal({
                code: 1,
                stdout: '',
                stderr: 'kelpi web eval: the page threw\n  Unknown web action: navigate\n  at <anonymous>:1:1\n'
            })
        ).toBeNull();
    });

    it('leaves a refusal to PERFORM the command alone, so a step can still assert on one', () => {
        expect(cliUsageRefusal({ code: 1, stdout: '', stderr: 'workspace not found: poster-swap\n' })).toBeNull();
        expect(cliUsageRefusal({ code: 1, stdout: '', stderr: 'Unknown event type: whatever\n' })).toBeNull();
        expect(cliUsageRefusal({ code: 1, stdout: '', stderr: 'Unknown sync mode: sideways\n' })).toBeNull();
    });

    it('says nothing about a call that worked', () => {
        expect(cliUsageRefusal({ code: 0, stdout: '', stderr: 'Unknown command: warned about, then exited 0' })).toBeNull();
        expect(cliUsageRefusal({ code: 0, stdout: '', stderr: '' })).toBeNull();
    });
});

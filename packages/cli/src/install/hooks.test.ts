/**
 * The installer's filesystem behaviour: what it creates, what it refuses, what it backs up, and
 * what `--dry-run` promises (CLI-145, CLI-147, AGNT-123, AGNT-124).
 *
 * Every path here lives under an `mkdtemp` root. Nothing in this file may ever resolve to the
 * developer's own `~/.claude` or `~/.codex`: an installer test that wrote there would rewrite the
 * agent config of the machine running the suite, which is exactly the failure mode `--claude-dir`
 * exists to make impossible.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeInstallFs } from './fs.js';
import { BACKUP_SUFFIX, CODEX_TRUST_NOTE, installHooks } from './hooks.js';
import { findBundledSkill } from './skill.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'hooks');

let root = '';
let claudeDir = '';
let codexDir = '';

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-install-hooks-'));
    claudeDir = path.join(root, '.claude');
    codexDir = path.join(root, '.codex');
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function run(overrides: { dryRun?: boolean; commandPrefix?: string; skillSource?: string } = {}) {
    return installHooks(
        {
            claudeDir,
            codexDir,
            commandPrefix: overrides.commandPrefix ?? 'kelpi',
            dryRun: overrides.dryRun ?? false,
            // Default: no skill source at all, so the hook cases stay about hooks. The skill
            // suite below opts in with a fixture directory.
            skillSource: overrides.skillSource
        },
        nodeInstallFs
    );
}

const settingsFile = (): string => path.join(claudeDir, 'settings.json');
const codexFile = (): string => path.join(codexDir, 'hooks.json');
const read = (file: string): string => fs.readFileSync(file, 'utf8');
const golden = (name: string): string => fs.readFileSync(path.join(fixtures, name), 'utf8');

describe('a fresh machine', () => {
    it('creates ~/.claude/settings.json (and the directory) with the Python\'s exact bytes', () => {
        const result = run();
        expect(result.ok).toBe(true);
        expect(result.claude.action).toBe('created');
        expect(result.claude.backup).toBeUndefined();
        expect(read(settingsFile())).toBe(golden('expected-claude-fresh.json'));
    });

    it('skips Codex when ~/.codex does not exist, and says why', () => {
        const result = run();
        expect(result.codex.action).toBe('skipped');
        expect(result.codex.reason).toContain('Codex CLI not detected');
        expect(fs.existsSync(codexDir)).toBe(false);
        expect(result.notes).toEqual([]);
    });

    it('writes the four Codex hooks when ~/.codex is there, with the trust note', () => {
        fs.mkdirSync(codexDir, { recursive: true });
        const result = run();
        expect(result.codex.action).toBe('created');
        expect(read(codexFile())).toBe(golden('expected-codex-fresh.json'));
        expect(result.notes).toEqual([CODEX_TRUST_NOTE]);
    });
});

describe('re-running it', () => {
    it('is idempotent: identical bytes, reported as unchanged, with no backup churn', () => {
        run();
        const first = read(settingsFile());
        const result = run();
        expect(result.claude.action).toBe('unchanged');
        expect(read(settingsFile())).toBe(first);
        expect(fs.existsSync(`${settingsFile()}${BACKUP_SUFFIX}`)).toBe(false);
    });

    it('backs the old file up before it changes it', () => {
        fs.mkdirSync(claudeDir, { recursive: true });
        const before = golden('input-claude-usermerge.json');
        fs.writeFileSync(settingsFile(), before, 'utf8');

        const result = run();
        expect(result.claude.action).toBe('merged');
        expect(result.claude.backup).toBe(`${settingsFile()}${BACKUP_SUFFIX}`);
        expect(read(`${settingsFile()}${BACKUP_SUFFIX}`)).toBe(before);
        expect(read(settingsFile())).toBe(golden('expected-claude-usermerge.json'));
    });

    it('upgrades a pre-v0.19 install in place', () => {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(settingsFile(), golden('input-claude-stale.json'), 'utf8');
        const result = run();
        expect(result.claude.action).toBe('merged');
        expect(read(settingsFile())).toBe(golden('expected-claude-stale-migrated.json'));
    });
});

describe('refusals', () => {
    it('never overwrites a settings.json that is not valid JSON', () => {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(settingsFile(), '{ "hooks": ', 'utf8');

        const result = run();
        expect(result.ok).toBe(false);
        expect(result.claude.action).toBe('failed');
        expect(result.claude.reason).toContain('not valid JSON');
        expect(read(settingsFile())).toBe('{ "hooks": ');
        expect(fs.existsSync(`${settingsFile()}${BACKUP_SUFFIX}`)).toBe(false);
    });

    it('leaves an earlier good backup intact when it refuses', () => {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(settingsFile(), golden('input-claude-usermerge.json'), 'utf8');
        run(); // makes the backup
        fs.writeFileSync(settingsFile(), 'not json at all', 'utf8');

        const result = run();
        expect(result.ok).toBe(false);
        expect(read(`${settingsFile()}${BACKUP_SUFFIX}`)).toBe(golden('input-claude-usermerge.json'));
    });

    it('treats a broken Codex file as a warning, not a failure — Claude still gets its hooks', () => {
        fs.mkdirSync(codexDir, { recursive: true });
        fs.writeFileSync(codexFile(), '}}}', 'utf8');

        const result = run();
        expect(result.ok).toBe(true);
        expect(result.claude.action).toBe('created');
        expect(read(settingsFile())).toBe(golden('expected-claude-fresh.json'));
        expect(result.codex.action).toBe('failed');
        expect(result.warnings.join(' ')).toContain('Claude Code hooks above are unaffected');
        expect(read(codexFile())).toBe('}}}');
    });
});

describe('--dry-run', () => {
    it('writes nothing at all, and previews exactly what a real run would write', () => {
        fs.mkdirSync(codexDir, { recursive: true });
        const dry = run({ dryRun: true });
        expect(dry.dryRun).toBe(true);
        expect(dry.claude.action).toBe('created');
        expect(fs.existsSync(claudeDir)).toBe(false);
        expect(fs.existsSync(codexFile())).toBe(false);

        const real = run();
        expect(dry.claude.preview).toBe(read(settingsFile()));
        expect(dry.codex.preview).toBe(read(codexFile()));
        expect(real.claude.action).toBe('created');
    });

    it('reports `merged` (not `unchanged`) for a config that still needs the upgrade', () => {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(settingsFile(), golden('input-claude-stale.json'), 'utf8');
        const dry = run({ dryRun: true });
        expect(dry.claude.action).toBe('merged');
        expect(dry.claude.preview).toBe(golden('expected-claude-stale-migrated.json'));
        expect(read(settingsFile())).toBe(golden('input-claude-stale.json'));
    });
});

describe('the bundled kelpi-agentic skill (CLI-146)', () => {
    function bundleSkill(body: string): string {
        const dir = path.join(root, 'bundle', 'skills', 'kelpi-agentic');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
        return dir;
    }

    const destination = (): string => path.join(claudeDir, 'skills', 'kelpi-agentic', 'SKILL.md');

    it('is skipped, silently, when the build carries none', () => {
        const result = run();
        expect(result.skill.action).toBe('skipped');
        expect(result.ok).toBe(true);
        expect(fs.existsSync(path.join(claudeDir, 'skills'))).toBe(false);
    });

    it('is copied into <claude-dir>/skills/kelpi-agentic/', () => {
        const source = bundleSkill('# Kelpi Agentic\n');
        const result = run({ skillSource: source });
        expect(result.skill.action).toBe('created');
        expect(result.skill.source).toBe(path.join(source, 'SKILL.md'));
        expect(fs.readFileSync(destination(), 'utf8')).toBe('# Kelpi Agentic\n');
    });

    it('reports `unchanged` on a re-run, and `updated` when the bundled copy moved on', () => {
        const source = bundleSkill('# v1\n');
        run({ skillSource: source });
        expect(run({ skillSource: source }).skill.action).toBe('unchanged');

        fs.writeFileSync(path.join(source, 'SKILL.md'), '# v2\n', 'utf8');
        expect(run({ skillSource: source }).skill.action).toBe('updated');
        expect(fs.readFileSync(destination(), 'utf8')).toBe('# v2\n');
    });

    it('writes nothing on a dry run', () => {
        const source = bundleSkill('# Kelpi Agentic\n');
        expect(run({ skillSource: source, dryRun: true }).skill.action).toBe('created');
        expect(fs.existsSync(destination())).toBe(false);
    });

    it('treats --skill-source as exclusive: an empty one does not fall through', () => {
        // A perfectly good skill sits beside the "running bundle" — and must still be ignored,
        // because the caller named a directory and got told what happened to THAT one.
        const beside = path.join(root, 'Resources', 'cli');
        fs.mkdirSync(path.join(beside, 'skills', 'kelpi-agentic'), { recursive: true });
        fs.writeFileSync(path.join(beside, 'skills', 'kelpi-agentic', 'SKILL.md'), '# packaged\n');
        const empty = path.join(root, 'empty');
        fs.mkdirSync(empty, { recursive: true });

        const result = installHooks(
            {
                claudeDir,
                codexDir,
                commandPrefix: 'kelpi',
                dryRun: false,
                skillSource: empty,
                executable: path.join(beside, 'kelpi.js')
            },
            nodeInstallFs
        );
        expect(result.skill.action).toBe('skipped');
        expect(fs.existsSync(path.join(claudeDir, 'skills'))).toBe(false);
    });

    it('finds a copy staged beside the running bundle, then one in the checkout', () => {
        // The packaged-app shape: <dir of kelpi.js>/skills/kelpi-agentic/SKILL.md.
        const beside = path.join(root, 'Resources', 'cli');
        fs.mkdirSync(path.join(beside, 'skills', 'kelpi-agentic'), { recursive: true });
        fs.writeFileSync(path.join(beside, 'skills', 'kelpi-agentic', 'SKILL.md'), '# packaged\n');
        const found = findBundledSkill({ claudeDir, executable: path.join(beside, 'kelpi.js'), dryRun: true }, nodeInstallFs);
        expect(found?.contents).toBe('# packaged\n');

        // The checkout shape: <dir of kelpi.js>/../resources/skills/kelpi-agentic/SKILL.md.
        const checkout = path.join(root, 'packages', 'cli');
        fs.mkdirSync(path.join(checkout, 'resources', 'skills', 'kelpi-agentic'), { recursive: true });
        fs.writeFileSync(path.join(checkout, 'resources', 'skills', 'kelpi-agentic', 'SKILL.md'), '# checkout\n');
        const fromCheckout = findBundledSkill(
            { claudeDir, executable: path.join(checkout, 'dist', 'kelpi.js'), dryRun: true },
            nodeInstallFs
        );
        expect(fromCheckout?.contents).toBe('# checkout\n');
    });

    it('ships in this repo, so a checkout install really has one', () => {
        const shipped = path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            '..',
            '..',
            'resources',
            'skills',
            'kelpi-agentic',
            'SKILL.md'
        );
        expect(fs.existsSync(shipped)).toBe(true);
        expect(fs.readFileSync(shipped, 'utf8')).toContain('name: kelpi-agentic');
    });
});

describe('a non-bare command prefix', () => {
    it('bakes the absolute path into every hook and still sweeps the bare install', () => {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(settingsFile(), golden('expected-claude-fresh.json'), 'utf8');

        const absolute = '/Users/dev/new_nex/packages/cli/dist/kelpi.js';
        const result = run({ commandPrefix: absolute });
        expect(result.claude.action).toBe('merged');
        const written = read(settingsFile());
        expect(written).toContain(`${absolute} event stop`);
        // Exactly one command per event: the bare variant was replaced, not doubled up.
        expect(written.match(/"command":/g)).toHaveLength(5);
    });
});

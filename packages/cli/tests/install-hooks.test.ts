/**
 * `kelpi install-hooks` driven as the real bundled binary (gap #1's acceptance).
 *
 * The unit tests cover the merge and the filesystem decisions; this covers the thing a user
 * actually types — argument parsing, which stream each line lands on, the exit codes, and the
 * `--json` object a script would read. It runs the CLI with a scratch `HOME`, so the default
 * `~/.claude` / `~/.codex` paths are exercised *without* touching the developer's own agent
 * config: `runCLI` points `HOME` at an `mkdtemp` directory (see `./harness.ts`).
 *
 * No socket is involved. `install-hooks` is a purely local command — the daemon does not need to
 * be running to fix a hook config, which is the whole point of it being in the CLI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildCLI, runCLI, scratchHome } from './harness.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hooks');
const golden = (name: string): string => fs.readFileSync(path.join(fixtures, name), 'utf8');

beforeAll(async () => {
    await buildCLI();
}, 60_000);

interface Dirs {
    readonly home: string;
    readonly claude: string;
    readonly codex: string;
    readonly settings: string;
    readonly codexHooks: string;
}

function dirs(options: { codex?: boolean } = {}): Dirs {
    const home = scratchHome();
    const claude = path.join(home, '.claude');
    const codex = path.join(home, '.codex');
    if (options.codex === true) fs.mkdirSync(codex, { recursive: true });
    return {
        home,
        claude,
        codex,
        settings: path.join(claude, 'settings.json'),
        codexHooks: path.join(codex, 'hooks.json')
    };
}

describe('kelpi install-hooks', () => {
    it('installs both hook sets into the default ~/.claude and ~/.codex', async () => {
        const d = dirs({ codex: true });
        const result = await runCLI(['install-hooks', '--command', 'kelpi'], { cwd: d.home });

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Configuring Claude Code hooks (command: kelpi)');
        expect(result.stdout).toContain(`created ${d.settings}`);
        expect(result.stdout).toContain('Configuring Codex CLI hooks');
        expect(result.stdout).toContain('run /hooks inside codex');
        expect(result.stdout).toContain('Restart any running agent sessions');
        expect(fs.readFileSync(d.settings, 'utf8')).toBe(golden('expected-claude-fresh.json'));
        expect(fs.readFileSync(d.codexHooks, 'utf8')).toBe(golden('expected-codex-fresh.json'));
    });

    it('honours --claude-dir / --codex-dir and never touches HOME then', async () => {
        const d = dirs();
        const claude = path.join(d.home, 'elsewhere', 'claude');
        const codex = path.join(d.home, 'elsewhere', 'codex');
        fs.mkdirSync(codex, { recursive: true });

        const result = await runCLI(
            ['install-hooks', '--claude-dir', claude, '--codex-dir', codex, '--command', 'kelpi'],
            { cwd: d.home }
        );
        expect(result.code).toBe(0);
        expect(fs.existsSync(path.join(claude, 'settings.json'))).toBe(true);
        expect(fs.existsSync(path.join(codex, 'hooks.json'))).toBe(true);
        expect(fs.existsSync(d.claude)).toBe(false);
    });

    it('says it is skipping Codex when ~/.codex is not there', async () => {
        const d = dirs();
        const result = await runCLI(['install-hooks', '--command', 'kelpi'], { cwd: d.home });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Skipping Codex CLI hooks');
        expect(result.stdout).toContain('Codex CLI not detected');
        expect(fs.existsSync(d.codex)).toBe(false);
    });

    it('is idempotent, and says so on the second run', async () => {
        const d = dirs();
        await runCLI(['install-hooks', '--command', 'kelpi'], { cwd: d.home });
        const before = fs.readFileSync(d.settings, 'utf8');
        const again = await runCLI(['install-hooks', '--command', 'kelpi'], { cwd: d.home });
        expect(again.code).toBe(0);
        expect(again.stdout).toContain('already up to date');
        expect(fs.readFileSync(d.settings, 'utf8')).toBe(before);
    });

    it('upgrades a real pre-v0.19 config and backs it up first', async () => {
        const d = dirs();
        fs.mkdirSync(d.claude, { recursive: true });
        fs.writeFileSync(d.settings, golden('input-claude-stale.json'), 'utf8');

        const result = await runCLI(['install-hooks', '--command', 'kelpi'], { cwd: d.home });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`backup: ${d.settings}.kelpi-backup`);
        expect(fs.readFileSync(d.settings, 'utf8')).toBe(golden('expected-claude-stale-migrated.json'));
        expect(fs.readFileSync(`${d.settings}.kelpi-backup`, 'utf8')).toBe(golden('input-claude-stale.json'));
    });

    it('refuses a malformed settings.json — exit 1, file untouched, error on stderr', async () => {
        const d = dirs();
        fs.mkdirSync(d.claude, { recursive: true });
        fs.writeFileSync(d.settings, '{ oops', 'utf8');

        const result = await runCLI(['install-hooks', '--command', 'kelpi'], { cwd: d.home });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('not valid JSON');
        expect(fs.readFileSync(d.settings, 'utf8')).toBe('{ oops');
        expect(fs.existsSync(`${d.settings}.kelpi-backup`)).toBe(false);
    });

    it('keeps a broken Codex config non-fatal (exit 0, warning on stderr)', async () => {
        const d = dirs({ codex: true });
        fs.writeFileSync(d.codexHooks, 'not json', 'utf8');

        const result = await runCLI(['install-hooks', '--command', 'kelpi'], { cwd: d.home });
        expect(result.code).toBe(0);
        expect(result.stderr).toContain('Skipping Codex hooks');
        expect(fs.readFileSync(d.settings, 'utf8')).toBe(golden('expected-claude-fresh.json'));
        expect(fs.readFileSync(d.codexHooks, 'utf8')).toBe('not json');
    });

    it('--dry-run writes nothing and says so', async () => {
        const d = dirs({ codex: true });
        const result = await runCLI(['install-hooks', '--dry-run', '--command', 'kelpi'], { cwd: d.home });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('would be created');
        expect(result.stdout).toContain('Dry run: nothing was written');
        expect(fs.existsSync(d.settings)).toBe(false);
        expect(fs.existsSync(d.codexHooks)).toBe(false);
    });

    it('--json prints one key-sorted object and nothing else', async () => {
        const d = dirs({ codex: true });
        const result = await runCLI(['install-hooks', '--json', '--command', 'kelpi'], { cwd: d.home });
        expect(result.code).toBe(0);
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(parsed).toMatchObject({
            ok: true,
            dry_run: false,
            command: 'kelpi',
            claude: { path: d.settings, action: 'created' },
            codex: { path: d.codexHooks, action: 'created' }
        });
        expect(result.stdout.trim().split('\n')).toHaveLength(1);
        expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    });

    it('--json reports a Claude failure with ok:false and exit 1', async () => {
        const d = dirs();
        fs.mkdirSync(d.claude, { recursive: true });
        fs.writeFileSync(d.settings, '[]', 'utf8'); // valid JSON, but not an object
        const result = await runCLI(['install-hooks', '--json', '--command', 'kelpi'], { cwd: d.home });
        expect(result.code).toBe(1);
        const parsed = JSON.parse(result.stdout) as { ok: boolean; claude: { action: string } };
        expect(parsed.ok).toBe(false);
        expect(parsed.claude.action).toBe('failed');
    });

    it('--link symlinks the CLI and warns when the directory is off PATH', async () => {
        const d = dirs();
        const installDir = path.join(d.home, 'bin');
        const result = await runCLI(
            ['install-hooks', '--link', '--install-dir', installDir, '--command', 'kelpi'],
            { cwd: d.home, env: { PATH: '/usr/bin:/bin' } }
        );
        expect(result.code).toBe(0);
        const link = path.join(installDir, 'kelpi');
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(process.cwd(), 'packages/cli/dist/kelpi.js')));
        expect(result.stdout).toContain(`linked ${link}`);
        expect(result.stderr).toContain('is not on this shell\'s PATH');
    });

    it('--link picks the bare `kelpi` command once the link is on PATH', async () => {
        const d = dirs();
        const installDir = path.join(d.home, 'bin');
        const result = await runCLI(['install-hooks', '--link', '--install-dir', installDir, '--json'], {
            cwd: d.home,
            env: { PATH: `${installDir}:/usr/bin:/bin` }
        });
        expect(result.code).toBe(0);
        const parsed = JSON.parse(result.stdout) as { command: string; link: { on_path: boolean } };
        expect(parsed.command).toBe('kelpi');
        expect(parsed.link.on_path).toBe(true);
        expect(fs.readFileSync(path.join(d.claude, 'settings.json'), 'utf8')).toBe(
            golden('expected-claude-fresh.json')
        );
    });

    it('bakes an absolute path into the hooks when it is NOT on PATH', async () => {
        const d = dirs();
        const result = await runCLI(['install-hooks', '--json'], { cwd: d.home, env: { PATH: '/usr/bin:/bin' } });
        expect(result.code).toBe(0);
        const parsed = JSON.parse(result.stdout) as { command: string };
        expect(parsed.command).toBe(fs.realpathSync(path.join(process.cwd(), 'packages/cli/dist/kelpi.js')));
        expect(fs.readFileSync(path.join(d.claude, 'settings.json'), 'utf8')).toContain(
            `${parsed.command} event stop`
        );
    });

    it('installs the bundled nex-agentic skill it ships beside itself', async () => {
        const d = dirs();
        const result = await runCLI(['install-hooks', '--json', '--command', 'kelpi'], { cwd: d.home });
        expect(result.code).toBe(0);
        const parsed = JSON.parse(result.stdout) as { skill: { action: string; path: string; source: string } };
        // Found via `<dist>/../resources/skills/nex-agentic` — the checkout shape.
        expect(parsed.skill.action).toBe('created');
        expect(parsed.skill.source.endsWith('packages/cli/resources/skills/nex-agentic/SKILL.md')).toBe(true);
        const installed = fs.readFileSync(path.join(d.claude, 'skills', 'nex-agentic', 'SKILL.md'), 'utf8');
        expect(installed).toContain('name: nex-agentic');
        expect(installed).toBe(fs.readFileSync(parsed.skill.path, 'utf8'));

        // Second run: nothing to do, and it says so rather than rewriting.
        const again = await runCLI(['install-hooks', '--json', '--command', 'kelpi'], { cwd: d.home });
        expect((JSON.parse(again.stdout) as { skill: { action: string } }).skill.action).toBe('unchanged');
    });

    it('skips the skill — quietly, and without failing — when there is none to install', async () => {
        const d = dirs();
        const empty = path.join(d.home, 'no-skill-here');
        fs.mkdirSync(empty, { recursive: true });
        const result = await runCLI(['install-hooks', '--command', 'kelpi', '--skill-source', empty, '--json'], {
            cwd: d.home
        });
        expect(result.code).toBe(0);
        // --skill-source is exclusive: naming an empty directory does NOT silently fall back to
        // the copy in the checkout.
        const parsed = JSON.parse(result.stdout) as { ok: boolean; skill: { action: string } };
        expect(parsed.ok).toBe(true);
        expect(parsed.skill.action).toBe('skipped');
        expect(fs.existsSync(path.join(d.claude, 'skills'))).toBe(false);
        // …and the hooks still went in, which is the point: the skill is a nice-to-have.
        expect(fs.existsSync(d.settings)).toBe(true);
    });

    it('rejects a stray positional and prints usage', async () => {
        const d = dirs();
        const result = await runCLI(['install-hooks', 'now'], { cwd: d.home });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("unexpected argument 'now'");
        expect(result.stderr).toContain('Usage:');
        expect(fs.existsSync(d.settings)).toBe(false);
    });

    it('prints its help to stdout and exits 0', async () => {
        const result = await runCLI(['install-hooks', '--help']);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('kelpi install-hooks');
        expect(result.stdout).toContain('--dry-run');
        expect(result.stderr).toBe('');
    });

    it('is listed in the top-level usage block', async () => {
        const result = await runCLI(['--help']);
        expect(result.stderr).toContain('kelpi install-hooks');
    });

    it('is what doctor now names as the repair', async () => {
        const d = dirs();
        fs.mkdirSync(d.claude, { recursive: true });
        fs.writeFileSync(d.settings, '{}', 'utf8');
        const before = await runCLI(['doctor'], { cwd: d.home });
        expect(before.stdout + before.stderr).toContain('kelpi install-hooks');
        expect(before.stdout + before.stderr).not.toContain('install-hooks.sh');

        await runCLI(['install-hooks', '--command', 'kelpi'], { cwd: d.home });
        const after = await runCLI(['doctor', '--json'], { cwd: d.home });
        const report = JSON.parse(after.stdout) as { checks: { name: string; status: string }[] };
        const hooks = report.checks.find((check) => check.name === 'hooks');
        expect(hooks?.status).toBe('pass');
    });
});

#!/usr/bin/env node
/**
 * Stage everything that goes into the packaged app's `Contents/Resources` **outside** the asar.
 *
 * `src/resources.ts` describes the layout and is the module the running app reads it back
 * through; this script is the half that writes it. Forge's `packagerConfig.extraResource`
 * copies each staged entry to `Contents/Resources/<basename>`, so the job here is to produce
 * exactly three things in one directory:
 *
 *   daemon/   the daemon payload — `packages/daemon/scripts/stage-payload.mjs` owns its
 *             contents (the bundle plus the node-pty tree its `require` resolves to). Run as a
 *             child process rather than imported, so the daemon package keeps sole ownership of
 *             its own payload and this script needs no knowledge of node-pty's internals.
 *   client/   `packages/client/dist` — the built web UI. The daemon serves it; the shell hands
 *             it over as `KELPID_CLIENT_DIR` at spawn time (`src/daemon.ts` `daemonSpawnEnv`).
 *   node      a Node 24 runtime for the daemon. NOT Electron: docs/research/stack.md is
 *             explicit that `ELECTRON_RUN_AS_NODE` is the wrong answer here (it fights the fuse
 *             hardening and couples the daemon's lifetime to the app bundle), and option 1 of
 *             its "what runs the detached daemon" list is "bundle an official Node binary".
 *
 * Plus `icon.icns`, which is staged rather than shipped as a resource (Forge reads it as
 * `packagerConfig.icon` and writes it into the bundle itself).
 *
 * ## About the Node binary
 *
 * This copies **the Node that is running this script** (or `KELPI_NODE_BINARY`). That is right
 * for a local `pnpm dist` and wrong for a release: a redistributed Node has to be the official
 * build for the target platform, and in a signed app it must be signed and given the
 * entitlements the app's own signature implies. The release checklist in the repo README says
 * so; this script's job is to make the local build honest, not to pretend it is a release.
 *
 *     node scripts/stage-resources.mjs [--out <dir>] [--platform darwin] [--arch arm64] [--skip-icon]
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeAppIcon } from './make-icon.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const require = createRequire(import.meta.url);

export const DEFAULT_STAGING_DIR = path.join(packageRoot, 'out', 'staging');

const DAEMON_STAGER = path.join(repoRoot, 'packages', 'daemon', 'scripts', 'stage-payload.mjs');
const CLIENT_DIST = path.join(repoRoot, 'packages', 'client', 'dist');
const CLI_DIST = path.join(repoRoot, 'packages', 'cli', 'dist');

/** The app's version, stamped into the CLI launcher so `kelpi --version` agrees with the app. */
function packageVersion() {
    try {
        return JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
    } catch {
        return undefined;
    }
}

function helpers() {
    const compiled = path.join(packageRoot, 'dist', 'packaging.cjs');
    try {
        return require(compiled);
    } catch (error) {
        throw new Error(
            `packaging helpers are not built (${compiled}). Run \`pnpm --filter @kelpi/shell build\` first.` +
                `\n  cause: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

// ── daemon payload ──────────────────────────────────────────────────────────────────

export function stageDaemon({ stagingDir, platform, arch }) {
    const outDir = path.join(stagingDir, 'daemon');
    const result = spawnSync(
        process.execPath,
        [DAEMON_STAGER, '--out', outDir, '--platform', platform, '--arch', arch],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    if (result.status !== 0) {
        throw new Error(`staging the daemon payload failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    }
    return { dir: outDir, entry: path.join(outDir, 'kelpid.js'), log: (result.stdout ?? '').trim() };
}

// ── client build ────────────────────────────────────────────────────────────────────

export function stageClient({ stagingDir, clientDist = CLIENT_DIST }) {
    if (!existsSync(path.join(clientDist, 'index.html'))) {
        throw new Error(
            `the web client is not built (${path.join(clientDist, 'index.html')} is missing). ` +
                'Run `pnpm --filter @kelpi/client build` first — a packaged app with no client would ' +
                'launch to the daemon\'s "client not built" page.'
        );
    }
    const outDir = path.join(stagingDir, 'client');
    rmSync(outDir, { recursive: true, force: true });
    cpSync(clientDist, outDir, { recursive: true, dereference: true });
    return { dir: outDir };
}

// ── Node runtime ────────────────────────────────────────────────────────────────────

/** Ask a candidate binary what it is. Returns `{version, arch}` or throws. */
export function probeNodeBinary(binary) {
    const result = spawnSync(binary, ['-p', 'process.versions.node + " " + process.arch'], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`${binary} did not answer as a Node binary: ${(result.stderr ?? '').trim()}`);
    }
    const [version = '', arch = ''] = (result.stdout ?? '').trim().split(' ');
    return { version, arch };
}

export function stageNode({ stagingDir, arch, binary = process.env['KELPI_NODE_BINARY'] ?? process.execPath }) {
    const { nodeRuntimeIssues } = helpers();
    if (!existsSync(binary)) throw new Error(`no Node binary at ${binary} (set KELPI_NODE_BINARY)`);
    const probe = probeNodeBinary(binary);
    const issues = nodeRuntimeIssues(probe, arch);
    if (issues.length > 0) {
        throw new Error(
            `refusing to bundle ${binary}: ${issues.join('; ')}. ` +
                'Set KELPI_NODE_BINARY to an official Node build for the target platform.'
        );
    }
    const target = path.join(stagingDir, 'node');
    rmSync(target, { force: true });
    cpSync(binary, target, { dereference: true });
    chmodSync(target, 0o755);
    return { path: target, source: binary, ...probe, bytes: statSync(target).size };
}

// ── the CLI payload ─────────────────────────────────────────────────────────────────

/**
 * `cli/` — the `kelpi` bundle plus the POSIX-sh launcher `/usr/local/bin/kelpi` points at.
 *
 * It ships OUTSIDE the asar for the same reason the daemon does: that symlink is exec'd by a
 * plain shell, and neither `sh` nor `node` can read through an Electron archive. The launcher
 * text comes from `src/packaging.ts` (`cliLauncherScript`) so the marker the app's
 * install-attribution looks for and the script carrying it are one definition — see
 * `src/cli-install.ts`.
 */
export function stageCli({ stagingDir, cliDist = CLI_DIST, version }) {
    const { cliLauncherScript } = helpers();
    const bundle = path.join(cliDist, 'kelpi.js');
    if (!existsSync(bundle)) {
        throw new Error(
            `the CLI is not built (${bundle} is missing). Run \`pnpm --filter @kelpi/cli build\` first — ` +
                'a packaged app without it could not install the `kelpi` command.'
        );
    }
    const outDir = path.join(stagingDir, 'cli');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    cpSync(bundle, path.join(outDir, 'kelpi.js'), { dereference: true });
    const map = `${bundle}.map`;
    if (existsSync(map)) cpSync(map, path.join(outDir, 'kelpi.js.map'), { dereference: true });
    const launcher = path.join(outDir, 'kelpi');
    writeFileSync(launcher, cliLauncherScript(version === undefined ? {} : { version }), 'utf8');
    chmodSync(launcher, 0o755);
    // The pre-rename `nex` compat launcher: identical content, so healed legacy
    // /usr/local/bin/nex links (and every hook that runs a bare `nex`) exec the same bundle.
    const compatLauncher = path.join(outDir, 'nex');
    writeFileSync(compatLauncher, cliLauncherScript(version === undefined ? {} : { version }), 'utf8');
    chmodSync(compatLauncher, 0o755);
    // `skills/` rides along beside the bundle: `kelpi install-hooks` looks for the kelpi-agentic
    // SKILL.md there first (`packages/cli/src/install/skill.ts`), which is how the packaged app
    // ships the skill the Swift bundle carried in Contents/Resources/skills.
    const skills = path.join(path.dirname(cliDist), 'resources', 'skills');
    if (existsSync(skills)) cpSync(skills, path.join(outDir, 'skills'), { recursive: true, dereference: true });
    return { dir: outDir, launcher, bundle: path.join(outDir, 'kelpi.js'), skills: path.join(outDir, 'skills') };
}

// ── the whole thing ─────────────────────────────────────────────────────────────────

export function stageResources({
    stagingDir = DEFAULT_STAGING_DIR,
    platform = process.platform,
    arch = process.arch,
    icon = true
} = {}) {
    mkdirSync(stagingDir, { recursive: true });
    const daemon = stageDaemon({ stagingDir, platform, arch });
    const client = stageClient({ stagingDir });
    const cli = stageCli({ stagingDir, version: packageVersion() });
    const node = stageNode({ stagingDir, arch });
    const icons = icon ? writeAppIcon(stagingDir) : undefined;
    return { stagingDir, daemon, client, cli, node, ...(icons === undefined ? {} : { icon: icons }) };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
    const argv = process.argv.slice(2);
    const value = (flag) => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    try {
        const staged = stageResources({
            stagingDir: value('--out') === undefined ? DEFAULT_STAGING_DIR : path.resolve(value('--out')),
            platform: value('--platform') ?? process.platform,
            arch: value('--arch') ?? process.arch,
            icon: !argv.includes('--skip-icon')
        });
        process.stdout.write(
            `staged resources → ${staged.stagingDir}\n` +
                `  daemon/  ${staged.daemon.entry}\n` +
                `  client/  ${staged.client.dir}\n` +
                `  cli/     ${staged.cli.launcher}\n` +
                `  node     ${staged.node.version} ${staged.node.arch} (${String(staged.node.bytes)} bytes, from ${staged.node.source})\n` +
                (staged.icon === undefined ? '' : `  icon     ${staged.icon.icns}\n`)
        );
    } catch (error) {
        process.stderr.write(`stage-resources: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    }
}

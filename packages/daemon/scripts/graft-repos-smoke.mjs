#!/usr/bin/env node
/**
 * Live smoke for the graft UI verbs, the repo registry verbs and repo auto-detect.
 *
 * The unit tests prove each piece against a stub. This proves the SYSTEM on real git: a real
 * repository with a real linked worktree, a real `nexd` on private paths, a real WebSocket
 * client sending the same verbs the inspector sends, and — for auto-detect — a real PTY whose
 * shell reports a real OSC 7 after a real `cd`.
 *
 * What only a live run can show:
 *   - a graft actually rewrites the PARENT's working tree (and puts it back on stop);
 *   - the breadcrumb appears and disappears on disk in step with the session;
 *   - a second worktree contesting the same parent is refused with the typed `alreadyActive`
 *     payload the swap prompt reads;
 *   - `graft-session-list --refresh` finds a planted breadcrumb and `graft-orphan-dismiss`
 *     deletes it;
 *   - a `repo-scan` walks a real tree, and a `repo-remove` cascade drops the association;
 *   - a pane's OSC 7 auto-links its worktree, and leaving it auto-unlinks and GCs the repo.
 *
 * Isolation: everything lives under a fresh `mkdtemp` (the sandbox helper the UI audit uses),
 * the control socket is `<tmp>/nexd.sock` and never `/tmp/nex.sock`, ports are ephemeral and
 * never the developer's dev stack.
 *
 *   node packages/daemon/scripts/graft-repos-smoke.mjs [--no-build] [--keep] [--verbose]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAll, makeSandbox, sleep, startDaemon, waitForHealthz } from '../../../scripts/ui-audit/lib/stack.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const argv = new Set(process.argv.slice(2));
const options = {
    build: !argv.has('--no-build'),
    keep: argv.has('--keep'),
    verbose: argv.has('--verbose')
};

const results = [];
function check(label, ok, detail = '') {
    results.push({ label, ok, detail });
    process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail === '' ? '' : `  — ${detail}`}\n`);
}

// ── the git fixture ─────────────────────────────────────────────────────────────────

function makeFixture(sandbox) {
    const root = path.join(sandbox.root, 'code');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const git = (args, cwd = repo) =>
        execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            env: {
                PATH: sandbox.env.PATH,
                HOME: sandbox.home,
                GIT_AUTHOR_NAME: 'Smoke',
                GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
                GIT_COMMITTER_NAME: 'Smoke',
                GIT_COMMITTER_EMAIL: 'smoke@example.invalid'
            }
        });
    git(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# parent\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'initial']);
    // A dirty parent, so the stash/restore half of start+stop is exercised.
    fs.writeFileSync(path.join(repo, 'README.md'), '# parent\n\nlocal edit\n');

    // Two linked worktrees: one to graft, one to contest the same parent with.
    const wt = path.join(root, 'wt');
    const wt2 = path.join(root, 'wt2');
    git(['worktree', 'add', '-q', '-b', 'graft-branch', wt]);
    fs.writeFileSync(path.join(wt, 'GRAFT.md'), 'mirrored\n');
    git(['add', '.'], wt);
    git(['commit', '-q', '-m', 'marker'], wt);
    git(['worktree', 'add', '-q', '-b', 'other-branch', wt2]);

    // A second, unrelated repo so `repo-scan` has more than one thing to find.
    const other = path.join(root, 'other');
    fs.mkdirSync(other, { recursive: true });
    git(['init', '-q', '-b', 'main'], other);

    return { root, repo, wt, wt2, other };
}

// ── a minimal WS client ─────────────────────────────────────────────────────────────

async function connectWs(base, token) {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
    const messages = [];
    const waiters = [];
    socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        messages.push(JSON.parse(event.data));
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
            const hit = messages.find(waiters[index].match);
            if (hit !== undefined) waiters.splice(index, 1)[0].resolve(hit);
        }
    };
    await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error('the WebSocket failed to open'));
    });
    const waitJson = (match, label, timeoutMs = 20_000) =>
        new Promise((resolve, reject) => {
            const existing = messages.find(match);
            if (existing !== undefined) {
                resolve(existing);
                return;
            }
            const waiter = { match, resolve };
            waiters.push(waiter);
            setTimeout(() => {
                const at = waiters.indexOf(waiter);
                if (at < 0) return;
                waiters.splice(at, 1);
                reject(new Error(`timed out waiting for ${label}`));
            }, timeoutMs).unref?.();
        });

    socket.send(JSON.stringify({ type: 'hello', protocolVersion: 1, client: { kind: 'browser' } }));
    await waitJson((m) => m.type === 'welcome', 'welcome');
    const snapshot = await waitJson((m) => m.type === 'snapshot', 'snapshot');

    let sequence = 0;
    const command = async (payload, label = payload.command) => {
        sequence += 1;
        const id = `smoke-${String(sequence)}`;
        socket.send(JSON.stringify({ type: 'command', id, payload }));
        const answer = await waitJson((m) => m.type === 'command-reply' && m.id === id, label);
        return answer.reply;
    };
    return { socket, messages, waitJson, command, snapshot, close: () => socket.close() };
}

/** `<run dir>/daemon-v<PROTOCOL_VERSION>.token`, whatever the daemon actually wrote. */
function readToken(sandbox) {
    const entries = fs.readdirSync(sandbox.runDir).filter((name) => name.endsWith('.token'));
    const chosen = entries[0];
    if (chosen === undefined) throw new Error(`no token file in ${sandbox.runDir}`);
    return fs.readFileSync(path.join(sandbox.runDir, chosen), 'utf8').trim();
}

const breadcrumbAt = (repo) => path.join(repo, '.git', 'nex-graft-active');

// ── the run ─────────────────────────────────────────────────────────────────────────

async function main() {
    if (options.build) {
        await buildAll(repoRoot, { log: (line) => process.stdout.write(`  ${line}\n`) });
    }
    const sandbox = await makeSandbox(repoRoot, { label: 'graft' });
    const fixture = makeFixture(sandbox);
    const daemon = startDaemon(sandbox, { repoRoot, verbose: options.verbose });
    let ws;
    try {
        await waitForHealthz(sandbox.base);
        ws = await connectWs(sandbox.base, readToken(sandbox));

        const workspaceID = ws.snapshot.state.workspaces[0].id;
        const paneID = ws.snapshot.state.workspaces[0].panes[0].id;

        // ── the registry verbs ──────────────────────────────────────────────────
        const scan = await ws.command({ command: 'repo-scan', path: fixture.root });
        check(
            'repo-scan registers every checkout it walked to',
            scan.ok === true && scan.added.length >= 2,
            `${String(scan.scanned)} scanned, ${String(scan.added?.length)} added`
        );
        const registry = await ws.command({ command: 'repo-registry' });
        const parent = registry.repos.find((entry) => entry.path === fs.realpathSync(fixture.repo) || entry.path === fixture.repo);
        check('the parent repo is in the registry', parent !== undefined, JSON.stringify(registry.repos.map((r) => r.name)));

        const rescan = await ws.command({ command: 'repo-scan', path: fixture.root });
        check('a second scan adds nothing and says which it skipped', rescan.added.length === 0 && rescan.skipped.length >= 2, JSON.stringify(rescan.skipped.length));

        const renamed = await ws.command({ command: 'repo-rename', repo_id: parent.id, name: 'Parent Repo' });
        check('repo-rename renames the registry row', renamed.ok === true && renamed.repo.name === 'Parent Repo', JSON.stringify(renamed.repo?.name));

        // ── an association for the worktree, then graft ─────────────────────────
        const associated = await ws.command({
            command: 'add-repo-association',
            workspace_id: workspaceID,
            path: fixture.wt
        });
        check(
            'the worktree associates and is classified as a worktree, not the main checkout',
            associated.ok === true && associated.association.is_worktree === true,
            JSON.stringify(associated.association?.branch)
        );
        const associationID = associated.association.id;

        const started = await ws.command({ command: 'graft-session-start', association_id: associationID });
        check('graft-session-start answers with a live session', started.ok === true && started.session.status !== undefined, JSON.stringify(started.session ?? started.error));
        const changed = await ws.waitJson((m) => m.type === 'graft-changed' && m.sessions.length > 0, 'graft-changed');
        check('the daemon broadcasts graft-changed for the new session', changed.sessions[0].association_id.toLowerCase() === associationID.toLowerCase(), JSON.stringify(changed.sessions[0]));

        check(
            'the PARENT working tree now holds the worktree’s tracked file',
            fs.existsSync(path.join(fixture.repo, 'GRAFT.md')),
            path.join(fixture.repo, 'GRAFT.md')
        );
        check('a recovery breadcrumb is on disk while it runs', fs.existsSync(breadcrumbAt(fixture.repo)));

        // ── a second worktree contesting the same parent ────────────────────────
        const second = await ws.command({
            command: 'add-repo-association',
            workspace_id: workspaceID,
            path: fixture.wt2
        });
        const contested = await ws.command({ command: 'graft-session-start', association_id: second.association.id });
        check(
            'a second graft on the same parent is refused with the typed alreadyActive payload',
            contested.ok === false && contested.error_kind === 'alreadyActive' && typeof contested.parent_repo_root === 'string',
            JSON.stringify({ kind: contested.error_kind, root: contested.parent_repo_root })
        );

        // ── stop restores the parent ────────────────────────────────────────────
        const stopped = await ws.command({ command: 'graft-session-stop', association_id: associationID });
        check('graft-session-stop succeeds', stopped.ok === true, JSON.stringify(stopped.error));
        check('the mirrored file is gone from the parent again', !fs.existsSync(path.join(fixture.repo, 'GRAFT.md')));
        check(
            'the parent’s own uncommitted edit came back out of the stash',
            fs.readFileSync(path.join(fixture.repo, 'README.md'), 'utf8').includes('local edit')
        );
        check('the breadcrumb is gone', !fs.existsSync(breadcrumbAt(fixture.repo)));

        // ── orphan detection over a planted breadcrumb ──────────────────────────
        fs.writeFileSync(
            breadcrumbAt(fixture.repo),
            JSON.stringify({
                assocId: associationID,
                branch: 'graft-branch',
                preGraftBranch: 'main',
                preGraftSha: null,
                stashRef: null,
                stashed: false,
                version: 1,
                worktreePath: fixture.wt,
                worktreePreGraftSha: null
            })
        );
        const refreshed = await ws.command({ command: 'graft-session-list', refresh: true });
        check(
            'a planted breadcrumb surfaces as an interrupted graft',
            refreshed.ok === true && refreshed.orphans.length === 1,
            JSON.stringify(refreshed.orphans)
        );
        const orphanID = refreshed.orphans[0]?.association_id;
        const dismissed = await ws.command({ command: 'graft-orphan-dismiss', association_id: orphanID });
        check('dismissing deletes the breadcrumb and the row', dismissed.ok === true && !fs.existsSync(breadcrumbAt(fixture.repo)));
        const afterDismiss = await ws.command({ command: 'graft-session-list' });
        check('and it stays gone', afterDismiss.orphans.length === 0);

        // ── the cascade ─────────────────────────────────────────────────────────
        const removed = await ws.command({ command: 'repo-remove', repo_id: parent.id });
        check(
            'repo-remove drops the repo AND its associations',
            removed.ok === true && removed.removed_associations.length === 2,
            JSON.stringify(removed.removed_associations?.length)
        );
        const afterRemove = await ws.command({ command: 'workspace-repo-status', workspace_id: workspaceID });
        check('the workspace has no associations left', afterRemove.associations.length === 0);

        // ── auto-detect over a real PTY ─────────────────────────────────────────
        // A shell reports its directory with OSC 7; ghostty's shell integration emits it on
        // every `cd`. Nothing injects that integration here, so the smoke emits the same
        // sequence the integration would — the daemon's half is what is under test.
        const cd = `cd ${fixture.wt} && printf '\\033]7;file://%s%s\\007' "$(hostname)" "$PWD"\n`;
        await ws.command({ command: 'pane-send', pane_id: paneID, target: paneID, text: cd, bare: true });
        await sleep(2500);
        const linked = await ws.command({ command: 'workspace-repo-status', workspace_id: workspaceID });
        const autoRow = linked.associations.find((row) => row.is_auto_detected === true);
        check(
            'a pane cd-ing into a worktree auto-links it',
            autoRow !== undefined,
            JSON.stringify(linked.associations.map((row) => `${row.repo_name}:${String(row.is_auto_detected)}`))
        );
        const autoRegistry = await ws.command({ command: 'repo-registry' });
        check(
            'and registers its parent repo as auto-discovered',
            autoRegistry.repos.some((entry) => entry.is_auto_discovered === true),
            JSON.stringify(autoRegistry.repos.map((entry) => `${entry.name}:${String(entry.is_auto_discovered)}`))
        );

        const leave = `cd ${sandbox.home} && printf '\\033]7;file://%s%s\\007' "$(hostname)" "$PWD"\n`;
        await ws.command({ command: 'pane-send', pane_id: paneID, target: paneID, text: leave, bare: true });
        // The auto-unlink debounce is 5 s (§GIT-080) — deliberately long, so a pane that steps
        // out and back does not lose its association.
        await sleep(7000);
        const unlinked = await ws.command({ command: 'workspace-repo-status', workspace_id: workspaceID });
        check(
            'leaving the worktree auto-unlinks it',
            unlinked.associations.length === 0,
            JSON.stringify(unlinked.associations.map((row) => row.worktree_path))
        );
        const gcRegistry = await ws.command({ command: 'repo-registry' });
        check(
            'and the auto-discovered repo is garbage-collected',
            !gcRegistry.repos.some((entry) => entry.is_auto_discovered === true),
            JSON.stringify(gcRegistry.repos.map((entry) => entry.name))
        );
    } finally {
        const failed = results.filter((entry) => !entry.ok);
        process.stdout.write(
            `\n${String(results.length - failed.length)}/${String(results.length)} checks passed\n`
        );
        if (failed.length > 0) {
            process.stdout.write(`\n--- daemon log (tail) ---\n${daemon.text().split('\n').slice(-40).join('\n')}\n`);
        }
        if (options.keep) {
            process.stdout.write(`\nsandbox kept: ${sandbox.root}\n`);
        } else {
            ws?.close();
            await daemon.stop();
            sandbox.cleanup();
        }
        process.exitCode = failed.length === 0 ? 0 : 1;
    }
}

await main();

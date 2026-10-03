/**
 * The bundled binary against a fake control server: exit codes, stream discipline, and the
 * exact JSON that reaches the socket.
 *
 * What this covers that unit tests cannot:
 *   - the process contract — `dist/kelpi.js` is executable via its shebang, stdout survives the
 *     exit path, and every command lands on the documented exit code;
 *   - the three reply disciplines — request/response, fire-and-forget (exit 0 even when the
 *     socket is dead), and the `--follow` stream;
 *   - the wire payloads, including the legacy quirks (`"text":"true"`, the always-present
 *     `bare` boolean, `--top-level` expressed by omitting `group`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION } from '@kelpi/protocol';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CLI_VERSION } from '../src/version.js';
import {
    buildCLI,
    deadPort,
    runCLI as invokeCLI,
    scratchHome,
    startFakeServer,
    type FakeServer,
    type ServerReply
} from './harness.js';

const PANE = '9C2B9A2E-1111-2222-3333-444455556666';
const OTHER = '0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9';

let server: FakeServer;

beforeAll(async () => {
    await buildCLI();
}, 60_000);

beforeEach(async () => {
    server = await startFakeServer();
});

afterEach(async () => {
    await server.close();
});

afterAll(() => undefined);

/**
 * Requests already on the server when the current `runCLI` started. A fire-and-forget CLI
 * flushes its line to the kernel and EXITS; under a loaded suite the child's exit can reach
 * this process before the fake server's socket delivers the data, so "the CLI resolved"
 * does not mean "the request is recorded" — this floor plus the poll below is what does
 * (a battery died on exactly that inversion, 2026-09-01).
 */
let requestFloor = 0;

const wrappedRunCLI: typeof invokeCLI = (args, options) => {
    requestFloor = server.requests.length;
    return invokeCLI(args, options);
};
// Every test in this file goes through the wrapper; the harness import keeps its name out.
const runCLI = wrappedRunCLI;

/** The last request the CLI sent — awaited past the floor, so a late delivery still lands. */
async function lastRequest(): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5000;
    while (server.requests.length <= requestFloor && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const request = server.requests[server.requests.length - 1];
    if (request === undefined) throw new Error('no request reached the server');
    return request;
}

describe('dispatcher', () => {
    it('runs from its own shebang and prints its version to stdout', async () => {
        const result = await runCLI(['--version'], { direct: true });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(`kelpi ${CLI_VERSION}\n`);
        expect(result.stderr).toBe('');
    });

    it('prints usage to STDERR with exit 1 for no arguments and exit 0 for --help', async () => {
        const bare = await runCLI([]);
        expect(bare.code).toBe(1);
        expect(bare.stdout).toBe('');
        expect(bare.stderr).toContain('Usage:');

        const help = await runCLI(['--help']);
        expect(help.code).toBe(0);
        expect(help.stdout).toBe('');
        expect(help.stderr).toContain('kelpi doctor [--json]');
    });

    it('names an unknown command before the usage block', async () => {
        const result = await runCLI(['frobnicate']);
        expect(result.code).toBe(1);
        expect(result.stderr.startsWith('Unknown command: frobnicate\n')).toBe(true);
    });

    it('prints a subcommand help block to STDOUT, exit 0', async () => {
        const result = await runCLI(['pane', 'capture', '--help']);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Usage:');
        expect(result.stdout).toContain('--scrollback');
        expect(result.stderr).toBe('');
    });
});

describe('request/response', () => {
    it('unwraps the panes array under --json, sorted', async () => {
        server.respond(() => ({
            lines: [
                {
                    ok: true,
                    panes: [
                        { workspace_name: 'alpha', id: PANE, type: 'shell', status: 'idle', working_directory: '/tmp' }
                    ]
                }
            ]
        }));
        const result = await runCLI(['pane', 'list', '--json'], { port: server.port });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(
            `[{"id":"${PANE}","status":"idle","type":"shell","working_directory":"/tmp","workspace_name":"alpha"}]\n`
        );
        expect(await lastRequest()).toEqual({ command: 'pane-list' });
    });

    it('renders the table when --json is absent', async () => {
        server.respond(() => ({
            lines: [
                {
                    ok: true,
                    panes: [
                        {
                            id: PANE,
                            label: 'worker-1',
                            type: 'shell',
                            workspace_name: 'alpha',
                            status: 'running',
                            working_directory: '/tmp'
                        }
                    ]
                }
            ]
        }));
        const result = await runCLI(['pane', 'list', '--no-header'], { port: server.port });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(`${PANE}  worker-1  shell  alpha  running  -  /tmp\n`);
    });

    it('prints the pane-mutation ack and strips `ok` under --json', async () => {
        server.respond(() => ({
            lines: [{ ok: true, pane_id: OTHER, label: 'worker-2', workspace_name: 'alpha', workspace_id: PANE }]
        }));
        const ack = await runCLI(['pane', 'split', '--target', PANE, '--name', 'worker-2'], { port: server.port });
        expect(ack.code).toBe(0);
        expect(ack.stdout).toBe(`split pane: ${OTHER} (worker-2) in workspace alpha\n`);
        expect(await lastRequest()).toEqual({ command: 'pane-split', target: PANE, name: 'worker-2' });

        const json = await runCLI(['pane', 'split', '--target', PANE, '--json'], { port: server.port });
        expect(JSON.parse(json.stdout)).toEqual({
            label: 'worker-2',
            pane_id: OTHER,
            workspace_id: PANE,
            workspace_name: 'alpha'
        });
    });

    /**
     * #295: new panes open in the BACKGROUND unless asked. Without `--focus` the CLI sends no
     * `focus` field at all (the daemon's default is background); with it, `focus: true`.
     */
    it('sends focus: true only with --focus on pane split and pane create', async () => {
        server.respond(() => ({ lines: [{ ok: true, pane_id: OTHER, workspace_name: 'alpha', workspace_id: PANE }] }));

        await runCLI(['pane', 'split', '--focus', '--name', 'w'], { port: server.port, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'pane-split', name: 'w', pane_id: PANE, focus: true });

        await runCLI(['pane', 'split', '--name', 'w'], { port: server.port, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'pane-split', name: 'w', pane_id: PANE });

        await runCLI(['pane', 'create', '--workspace', 'alpha', '--focus'], { port: server.port });
        expect(await lastRequest()).toEqual({ command: 'pane-create', workspace: 'alpha', focus: true });

        await runCLI(['pane', 'create', '--workspace', 'alpha'], { port: server.port });
        expect(await lastRequest()).toEqual({ command: 'pane-create', workspace: 'alpha' });
    });

    /** #295: `pane move` is background by default too; `--focus` focuses the moved pane. */
    it('sends focus: true only with --focus on both forms of pane move', async () => {
        server.respond(() => ({ lines: [{ ok: true, pane_id: OTHER, anchor_id: PANE, workspace_name: 'alpha' }] }));

        await runCLI(['pane', 'move', '--target', 'worker', '--right-of', PANE], { port: server.port, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'pane-move-adjacent', target: 'worker', anchor: PANE, zone: 'right-of', pane_id: PANE });

        await runCLI(['pane', 'move', '--target', 'worker', '--below', PANE, '--focus'], { port: server.port, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'pane-move-adjacent', target: 'worker', anchor: PANE, zone: 'below', pane_id: PANE, focus: true });

        await runCLI(['pane', 'move', 'left'], { port: server.port, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'pane-move', pane_id: PANE, direction: 'left' });

        await runCLI(['pane', 'move', '--focus', 'right'], { port: server.port, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'pane-move', pane_id: PANE, direction: 'right', focus: true });

        const help = await runCLI(['pane', 'move', '--help'], { port: server.port });
        expect(help.stdout).toContain('--focus                     Focus the moved pane (default: background).');
    });

        it('documents --focus and the background default in pane split/create help', async () => {
        for (const verb of ['split', 'create']) {
            const help = await runCLI(['pane', verb, '--help'], { port: server.port });
            expect(help.code).toBe(0);
            expect(help.stdout).toContain('[--focus]');
            expect(help.stdout).toContain('--focus                     Move focus to the new pane (default: background).');
            expect(help.stdout).toContain('The new pane opens in the');
        }
        expect(server.requests).toHaveLength(0);
    });

    it('exits 1 with the server\'s error on stderr and nothing on stdout', async () => {
        server.respond(() => ({ lines: [{ ok: false, error: "no pane matched target 'ghost'" }] }));
        const result = await runCLI(['pane', 'close', '--target', 'ghost', '--workspace', 'alpha'], {
            port: server.port
        });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe("kelpi pane close: no pane matched target 'ghost'\n");
    });

    it('writes capture output raw, with no added trailing newline', async () => {
        server.respond(() => ({ lines: [{ ok: true, text: 'line one\nline two\n' }] }));
        const result = await runCLI(['pane', 'capture', '--target', PANE, '--lines', '2', '--scrollback'], {
            port: server.port
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('line one\nline two\n');
        expect(await lastRequest()).toEqual({
            command: 'pane-capture',
            target: PANE,
            lines: 2,
            scrollback: true
        });
    });

    /**
     * cli.md §9.1: `pane id` is the one way a script inside a pane learns its own id. It read
     * the pre-rename NEX_PANE_ID after the port, which the daemon never injects, so it exited 1
     * inside every Kelpi pane while every other command saw the pane (#46). Pinned end to end:
     * the same KELPI_PANE_ID the harness gives every caller-pane case, and no socket traffic.
     */
    it('prints KELPI_PANE_ID from `pane id` and exits 1 outside a pane, never touching the socket', async () => {
        const inside = await runCLI(['pane', 'id'], { port: server.port, paneID: PANE });
        expect(inside.code).toBe(0);
        expect(inside.stdout).toBe(`${PANE}\n`);
        expect(inside.stderr).toBe('');

        const outside = await runCLI(['pane', 'id'], { port: server.port });
        expect(outside.code).toBe(1);
        expect(outside.stdout).toBe('');

        // Set-but-empty counts as unset (§9.1 says "set and non-empty").
        const empty = await runCLI(['pane', 'id'], { port: server.port, paneID: '' });
        expect(empty.code).toBe(1);
        expect(empty.stdout).toBe('');

        // The pre-rename variable is not a fallback: the daemon injects KELPI_* only (§4).
        const legacy = await runCLI(['pane', 'id'], { port: server.port, env: { NEX_PANE_ID: PANE } });
        expect(legacy.code).toBe(1);
        expect(legacy.stdout).toBe('');
        expect(server.requests).toHaveLength(0);
    });

    it('rejects a positional pane target instead of falling back to the caller', async () => {
        const result = await runCLI(['pane', 'capture', PANE], { port: server.port, paneID: OTHER });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
            `kelpi pane capture: unexpected argument '${PANE}' — target panes with --target <name-or-uuid>`
        );
        expect(server.requests).toHaveLength(0);
    });

    it('keeps `pane send`\'s empty-reply-is-success shim, and the opposite for send-key', async () => {
        server.respond(() => ({ silent: true }));
        const send = await runCLI(['pane', 'send', '--target', PANE, 'echo', 'hi'], { port: server.port });
        expect(send.code).toBe(0);
        expect(send.stdout).toBe('');
        expect(await lastRequest()).toEqual({ command: 'pane-send', target: PANE, text: 'echo hi', bare: false });

        const key = await runCLI(['pane', 'send-key', '--target', PANE, 'enter'], { port: server.port });
        expect(key.code).toBe(1);
        expect(key.stderr).toBe('kelpi pane send-key: empty reply (Kelpi version may not support this command)\n');
    });

    it('formats the resize ack as a whole-percent share', async () => {
        server.respond(() => ({
            lines: [{ ok: true, pane_id: PANE, workspace_name: 'alpha', target_share: 0.7499 }]
        }));
        const result = await runCLI(['pane', 'resize', '--target', PANE, '--grow'], { port: server.port });
        expect(result.stdout).toBe(`resized ${PANE} to 75% of its split in workspace alpha\n`);
        expect(await lastRequest()).toEqual({ command: 'pane-resize', delta: 0.05, target: PANE });
    });

    it('sends --shrink as a negative delta and --ratio as a ratio', async () => {
        server.respond(() => ({ lines: [{ ok: true, pane_id: PANE }] }));
        await runCLI(['pane', 'resize', '--target', PANE, '--shrink', '0.2'], { port: server.port });
        expect(await lastRequest()).toEqual({ command: 'pane-resize', delta: -0.2, target: PANE });
        await runCLI(['pane', 'resize', '--target', PANE, '--ratio', '0.4'], { port: server.port });
        expect(await lastRequest()).toEqual({ command: 'pane-resize', ratio: 0.4, target: PANE });
    });

    it('refuses a ratio outside (0,1) before touching the socket', async () => {
        const result = await runCLI(['pane', 'resize', '--target', PANE, '--ratio', '1.5'], { port: server.port });
        expect(result.code).toBe(1);
        expect(result.stderr).toBe('kelpi pane resize: --ratio must be a number between 0 and 1 (exclusive)\n');
        expect(server.requests).toHaveLength(0);
    });
});

describe('fire-and-forget', () => {
    it('sends one line and exits 0 with no output', async () => {
        const result = await runCLI(['group', 'create', 'squad', '--color', 'red'], { port: server.port });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
        expect(await lastRequest()).toEqual({ command: 'group-create', name: 'squad', color: 'red' });
    });

    it('ships `cascade` as a native boolean and `--top-level` by omitting `group`', async () => {
        await runCLI(['group', 'delete', 'squad'], { port: server.port });
        expect(await lastRequest()).toEqual({ command: 'group-delete', name: 'squad', cascade: false });

        await runCLI(['workspace', 'move', 'alpha', '--top-level', '--index', '2'], { port: server.port });
        expect(await lastRequest()).toEqual({ command: 'workspace-move', name: 'alpha', index: 2 });
    });

    it('keeps `pane move-to-workspace`\'s legacy field names', async () => {
        await runCLI(['pane', 'move-to-workspace', '--to-workspace', 'beta', '--create'], {
            port: server.port,
            paneID: PANE
        });
        expect(await lastRequest()).toEqual({
            command: 'pane-move-to-workspace',
            pane_id: PANE,
            name: 'beta',
            text: 'true'
        });
    });

    it('warns but still exits 0 when the socket is dead', async () => {
        const port = await deadPort();
        const result = await runCLI(['group', 'create', 'squad'], { port });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr.startsWith('Warning: kelpi: TCP connect to 127.0.0.1:')).toBe(true);
        expect(result.stderr).toContain('\nRepair: ');
    });

    it('is fully silent with KELPI_SILENT', async () => {
        const port = await deadPort();
        const result = await runCLI(['group', 'create', 'squad'], { port, env: { KELPI_SILENT: '1' } });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
    });

    it('turns the same failure into exit 1 for a request/response command', async () => {
        const port = await deadPort();
        const result = await runCLI(['pane', 'list'], { port });
        expect(result.code).toBe(1);
        expect(result.stderr.startsWith('Error: kelpi pane list: TCP connect to 127.0.0.1:')).toBe(true);
    });
});

describe('kelpi event', () => {
    it('forwards the hook payload fields it recognises', async () => {
        const result = await runCLI(['event', 'stop'], {
            port: server.port,
            paneID: PANE,
            stdin: JSON.stringify({
                session_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
                background_tasks: [{ type: 'shell', status: 'running' }, { type: 'subagent' }, { status: 'completed' }]
            })
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('');
        expect(await lastRequest()).toEqual({
            command: 'stop',
            pane_id: PANE,
            session_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
            background_tasks: 2
        });
    });

    it('reports KELPI_PROFILE beside a session id so a resume knows its profile', async () => {
        const payload = JSON.stringify({ session_id: 'sid-1' });
        await runCLI(['event', 'session-start'], {
            port: server.port,
            paneID: PANE,
            stdin: payload,
            env: { KELPI_PROFILE: 'work' }
        });
        expect(await lastRequest()).toEqual({
            command: 'session-start',
            pane_id: PANE,
            session_id: 'sid-1',
            profile: 'work'
        });

        // The dual-fire carrier (`stop` with a session id) reports it too…
        await runCLI(['event', 'stop'], {
            port: server.port,
            paneID: PANE,
            stdin: payload,
            env: { KELPI_PROFILE: 'work' }
        });
        expect(await lastRequest()).toEqual({
            command: 'stop',
            pane_id: PANE,
            session_id: 'sid-1',
            profile: 'work'
        });

        // …but session-end never does (its whole point is dropping the id), and no
        // KELPI_PROFILE means no key at all (wire-identical to the older CLI).
        await runCLI(['event', 'session-end'], {
            port: server.port,
            paneID: PANE,
            stdin: payload,
            env: { KELPI_PROFILE: 'work' }
        });
        expect(await lastRequest()).toEqual({ command: 'session-end', pane_id: PANE, session_id: 'sid-1' });
        await runCLI(['event', 'session-start'], { port: server.port, paneID: PANE, stdin: payload });
        expect(await lastRequest()).toEqual({ command: 'session-start', pane_id: PANE, session_id: 'sid-1' });
    });

    it('omits background_tasks entirely when nothing is in flight', async () => {
        await runCLI(['event', 'stop'], {
            port: server.port,
            paneID: PANE,
            stdin: JSON.stringify({ background_tasks: [{ status: 'completed' }] })
        });
        expect(await lastRequest()).toEqual({ command: 'stop', pane_id: PANE });
    });

    it('drops sub-agent start/stop before the socket, but not other events', async () => {
        const payload = JSON.stringify({ session_id: 'sid', agent_id: 'sub-agent-1' });
        await runCLI(['event', 'start'], { port: server.port, paneID: PANE, stdin: payload });
        expect(server.requests).toHaveLength(0);
        await runCLI(['event', 'session-end'], { port: server.port, paneID: PANE, stdin: payload });
        expect(await lastRequest()).toEqual({ command: 'session-end', pane_id: PANE, session_id: 'sid' });
    });

    it('composes codex notification defaults from the PermissionRequest payload', async () => {
        await runCLI(['event', 'notification', '--agent', 'codex'], {
            port: server.port,
            paneID: PANE,
            stdin: JSON.stringify({ tool_name: 'Bash' })
        });
        expect(await lastRequest()).toEqual({
            command: 'notification',
            pane_id: PANE,
            title: 'Codex',
            body: 'Approval requested: Bash',
            agent: 'codex'
        });
    });

    it('omits the title for a manual notification with no stdin', async () => {
        await runCLI(['event', 'notification', '--body', 'ping'], { port: server.port, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'notification', pane_id: PANE, body: 'ping' });
    });

    it('exits 0 and sends nothing outside a pane, but exits 1 on a bad --agent', async () => {
        const orphan = await runCLI(['event', 'start'], { port: server.port });
        expect(orphan.code).toBe(0);
        expect(orphan.stdout).toBe('');
        expect(server.requests).toHaveLength(0);

        const bad = await runCLI(['event', 'start', '--agent', 'gpt'], { port: server.port, paneID: PANE });
        expect(bad.code).toBe(1);
        expect(bad.stderr).toBe('Unknown --agent value: gpt (valid: claude, codex)\n');
        expect(server.requests).toHaveLength(0);
    });

    it('stays silent on a dead socket unless KELPI_VERBOSE_HOOKS is set', async () => {
        const port = await deadPort();
        // A pane shell would wait out a handoff gap (ROUTE_RETRY_WINDOW_MS); this port never opens.
        const noRetry = { KELPI_ROUTE_RETRY_MS: '0' };
        const quiet = await runCLI(['event', 'stop'], { port, paneID: PANE, env: noRetry });
        expect(quiet.code).toBe(0);
        expect(quiet.stderr).toBe('');

        const loud = await runCLI(['event', 'stop'], { port, paneID: PANE, env: { ...noRetry, KELPI_VERBOSE_HOOKS: '1' } });
        expect(loud.code).toBe(0);
        expect(loud.stderr).toContain('Warning: kelpi event stop:');
    });
});

describe('workspace delete', () => {
    it('records one result per id and exits 1 when any delete failed', async () => {
        server.respond((request) => {
            const name = String(request['name']);
            if (name === 'ghost') return { lines: [{ ok: false, error: 'workspace not found: ghost' }] };
            return { lines: [{ ok: true, workspace_id: PANE, workspace_name: name, path: '/tmp/wt' }] };
        });
        const result = await runCLI(['workspace', 'delete', 'alpha', 'ghost', 'alpha', '--json'], {
            port: server.port
        });
        expect(result.code).toBe(1);
        // The duplicate `alpha` is deduped, first-seen order preserved.
        expect(JSON.parse(result.stdout)).toEqual([
            { id: 'alpha', ok: true, workspace_id: PANE, workspace_name: 'alpha', path: '/tmp/wt' },
            { id: 'ghost', ok: false, error: 'workspace not found: ghost' }
        ]);
        expect(server.requests).toHaveLength(2);
        expect(server.requests[0]).toEqual({ command: 'workspace-delete', name: 'alpha', force: false });
    });

    it('carries the complete agent breakdown through a delete refusal', async () => {
        server.respond(() => ({
            lines: [
                {
                    ok: false,
                    error: 'workspace agents has 1 running agent, 2 agents waiting for input and 1 inactive agent; pass --force to delete anyway',
                    active_agents: 4, running: 1, waiting: 2, inactive: 1
                }
            ]
        }));
        const result = await runCLI(['workspace', 'delete', 'agents', '--json'], { port: server.port });
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual([
            {
                id: 'agents',
                ok: false,
                error: 'workspace agents has 1 running agent, 2 agents waiting for input and 1 inactive agent; pass --force to delete anyway',
                active_agents: 4, running: 1, waiting: 2, inactive: 1
            }
        ]);

        const forced = await runCLI(['workspace', 'delete', 'agents', '-y'], { port: server.port });
        expect(forced.code).toBe(1); // the fake still refuses; what matters is the flag on the wire
        expect(await lastRequest()).toEqual({ command: 'workspace-delete', name: 'agents', force: true });
    });

    it('asks the daemon to prune, and reports each worktree it removed or kept (graft-git §8.7)', async () => {
        server.respond(() => ({
            lines: [
                {
                    ok: true,
                    workspace_id: PANE,
                    workspace_name: 'feat',
                    path: '/wt/feat',
                    worktrees: [
                        { association_id: 'A1', worktree_path: '/wt/feat', branch: 'feat', removed: true, branch_deleted: true },
                        { association_id: 'A2', worktree_path: '/wt/other', branch: 'other', removed: true, branch_deleted: false, branch_error: '2 commits no other branch or remote has' },
                        { association_id: 'A3', worktree_path: '/wt/busy', branch: 'busy', removed: false, blocked: 'dirty', error: 'has 1 uncommitted change' }
                    ]
                }
            ]
        }));
        const result = await runCLI(['workspace', 'delete', 'feat', '--prune-worktree', '--delete-branch'], { port: server.port });
        expect(result.code).toBe(0);
        expect(await lastRequest()).toEqual({
            command: 'workspace-delete',
            name: 'feat',
            force: false,
            prune_worktrees: true,
            delete_branches: true
        });
        expect(result.stdout).toBe(
            'deleted workspace feat\n  removed worktree: /wt/feat\n  deleted branch: feat\n  removed worktree: /wt/other\n'
        );
        expect(result.stderr).toBe(
            'Warning: kept branch other: 2 commits no other branch or remote has\n' +
                'Warning: worktree /wt/busy not removed: has 1 uncommitted change\n'
        );

        const json = await runCLI(['workspace', 'delete', 'feat', '--prune-worktree', '--json'], { port: server.port });
        const [record] = JSON.parse(json.stdout) as Record<string, unknown>[];
        expect(record).toMatchObject({
            ok: true,
            worktree_pruned: false,
            worktree_error: 'worktree /wt/busy not removed: has 1 uncommitted change'
        });
        expect(record?.['worktrees']).toHaveLength(3);
    });

    it('warns when the daemon found no Kelpi worktree to prune', async () => {
        server.respond(() => ({ lines: [{ ok: true, workspace_id: PANE, workspace_name: 'Main', path: '/code/app', worktrees: [] }] }));
        const result = await runCLI(['workspace', 'delete', 'Main', '--prune-worktree'], { port: server.port });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe('Warning: workspace Main has no worktree Kelpi created to prune\n');
    });

    it('refuses --delete-branch without --prune-worktree, before sending anything', async () => {
        const result = await runCLI(['workspace', 'delete', 'feat', '--delete-branch'], { port: server.port });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('--delete-branch requires --prune-worktree');
        expect(server.requests).toHaveLength(0);
    });

    // A daemon that predates `prune_worktrees` answers without `worktrees`: the CLI falls back
    // to pruning the reply's `path` itself, as it always did.
    it('reports a prune that had no directory to work with (older daemon)', async () => {
        server.respond(() => ({ lines: [{ ok: true, workspace_id: PANE, workspace_name: 'Emptied' }] }));
        const result = await runCLI(['workspace', 'delete', 'Emptied', '--prune-worktree', '--json'], {
            port: server.port
        });
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([
            {
                id: 'Emptied',
                ok: true,
                workspace_id: PANE,
                workspace_name: 'Emptied',
                worktree_pruned: false,
                worktree_error: 'workspace Emptied had no panes; no directory to prune'
            }
        ]);
    });

    it('warns (exit 0) when the deleted directory is not a git worktree (older daemon)', async () => {
        const home = scratchHome();
        server.respond(() => ({ lines: [{ ok: true, workspace_id: PANE, workspace_name: 'Plain', path: home }] }));
        const result = await runCLI(['workspace', 'delete', 'Plain', '--prune-worktree'], {
            port: server.port,
            cwd: home
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('deleted workspace Plain\n');
        expect(result.stderr).toContain('Warning: not a git worktree, skipped prune:');
    });
});

describe('open / md / diff routing', () => {
    it('routes a markdown file to the `open` wire command, honouring --here', async () => {
        const home = scratchHome();
        fs.writeFileSync(path.join(home, 'notes.md'), '# hi\n');
        await runCLI(['open', '--here', 'notes.md'], { port: server.port, cwd: home, paneID: PANE });
        expect(await lastRequest()).toEqual({
            command: 'open',
            path: path.join(home, 'notes.md'),
            pane_id: PANE,
            reuse: true
        });
    });

    it('routes a URL to web-open and notes that --here does not apply', async () => {
        server.respond(() => ({ lines: [{ ok: true, pane_id: OTHER, url: 'https://example.com' }] }));
        const result = await runCLI(['open', '--here', 'example.com'], { port: server.port });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(`open ok: ${OTHER} (https://example.com)\n`);
        expect(result.stderr).toContain('--here is ignored for URLs');
        expect(await lastRequest()).toEqual({ command: 'web-open', url: 'example.com' });
    });

    it('routes a local .html file to web-open as a file:// URL', async () => {
        const home = scratchHome();
        fs.writeFileSync(path.join(home, 'page one.html'), '<h1>hi</h1>');
        server.respond(() => ({ lines: [{ ok: true, pane_id: OTHER }] }));
        await runCLI(['open', 'page one.html'], { port: server.port, cwd: home });
        expect(String((await lastRequest())['url']).endsWith('/page%20one.html')).toBe(true);
    });

    /** #295: `--focus` rides every route `kelpi open` / `kelpi md` can take; absent sends nothing. */
    it('sends focus: true only with --focus, on the markdown and web routes alike', async () => {
        const home = scratchHome();
        fs.writeFileSync(path.join(home, 'notes.md'), '# hi\n');
        server.respond(() => ({ lines: [{ ok: true, pane_id: OTHER, url: 'https://example.com' }] }));

        await runCLI(['open', '--focus', 'notes.md'], { port: server.port, cwd: home, paneID: PANE });
        expect(await lastRequest()).toEqual({
            command: 'open',
            path: path.join(home, 'notes.md'),
            pane_id: PANE,
            focus: true
        });
        await runCLI(['open', 'notes.md'], { port: server.port, cwd: home, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'open', path: path.join(home, 'notes.md'), pane_id: PANE });

        await runCLI(['md', '--focus', 'notes.md'], { port: server.port, cwd: home });
        expect(await lastRequest()).toEqual({ command: 'open', path: path.join(home, 'notes.md'), focus: true, as: 'markdown' });

        await runCLI(['open', '--focus', 'example.com'], { port: server.port });
        expect(await lastRequest()).toEqual({ command: 'web-open', url: 'example.com', focus: true });

        await runCLI(['web', 'open', '--focus', 'example.com'], { port: server.port, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'web-open', url: 'example.com', pane_id: PANE, focus: true });
        await runCLI(['web', 'open', 'example.com'], { port: server.port, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'web-open', url: 'example.com', pane_id: PANE });

        const help = await runCLI(['open', '--help'], { port: server.port });
        expect(help.stdout).toContain('Usage: kelpi open [--here] [--focus] <path-or-url>');
        expect(help.stdout).toContain('The new pane opens in the background; --focus moves focus to it.');
    });

    it('refuses a file type it has no pane for', async () => {
        const result = await runCLI(['open', 'archive.zip'], { port: server.port });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("kelpi open: don't know how to open '.zip' files");
        expect(result.stderr).toContain('Use `kelpi md <file>` to force a markdown pane');
        expect(result.stderr).toContain('CSV (.csv, .tsv) opens a');
        expect(server.requests).toHaveLength(0);
    });

    it('forces markdown for any extension with `kelpi md`', async () => {
        const home = scratchHome();
        await runCLI(['md', 'notes.txt'], { port: server.port, cwd: home });
        expect(await lastRequest()).toEqual({ command: 'open', path: path.join(home, 'notes.txt'), as: 'markdown' });
        // #324: a csv opened with `kelpi md` stays markdown source, not a table.
        await runCLI(['md', '--here', 'data.csv'], { port: server.port, cwd: home, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'open', path: path.join(home, 'data.csv'), pane_id: PANE, reuse: true, as: 'markdown' });
    });

    /** #324: `.csv`/`.tsv` ride the same `open` command; the daemon picks the table pane by extension. */
    it('routes csv and tsv files to `open`, honouring --here and --focus', async () => {
        const home = scratchHome();
        fs.writeFileSync(path.join(home, 'data.csv'), 'a,b\n1,2\n');
        await runCLI(['open', '--here', '--focus', 'data.csv'], { port: server.port, cwd: home, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'open', path: path.join(home, 'data.csv'), pane_id: PANE, reuse: true, focus: true });
        await runCLI(['open', 'Report.TSV'], { port: server.port, cwd: home });
        expect(await lastRequest()).toEqual({ command: 'open', path: path.join(home, 'Report.TSV') });

        const help = await runCLI(['open', '--help'], { port: server.port });
        expect(help.stdout).toContain('.csv/.tsv → table pane');
    });

    it('always sends the cwd as diff\'s repo_path and resolves the target', async () => {
        const home = scratchHome();
        await runCLI(['diff', 'src'], { port: server.port, cwd: home, paneID: PANE });
        expect(await lastRequest()).toEqual({
            command: 'diff',
            repo_path: home,
            target_path: path.join(home, 'src'),
            pane_id: PANE
        });
    });
});

describe('web', () => {
    it('pretty-prints the whole envelope under --json, before the ok check', async () => {
        server.respond(() => ({ lines: [{ ok: false, error: 'boom', js_error: { name: 'ReferenceError' } }] }));
        const result = await runCLI(['web', 'exec', '--target', PANE, '--json', 'return nope'], {
            port: server.port
        });
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: 'boom', js_error: { name: 'ReferenceError' } });
        // Multi-line, unlike every other --json shape.
        expect(result.stdout.includes('\n  ')).toBe(true);
    });

    it('keeps `exists` exit codes, with and without --json', async () => {
        server.respond(() => ({ lines: [{ ok: true, found: false }] }));
        const plain = await runCLI(['web', 'exists', '--target', PANE, 'css:#nope'], { port: server.port });
        expect(plain.code).toBe(1);
        expect(plain.stdout).toBe('');
        const json = await runCLI(['web', 'exists', '--target', PANE, 'css:#nope', '--json'], { port: server.port });
        expect(json.code).toBe(1);
        expect(JSON.parse(json.stdout)).toEqual({ ok: true, found: false });
    });

    it('reproduces the shipped capture flag set (no dom/all, --json ignored)', async () => {
        server.respond(() => ({ lines: [{ ok: true, mode: 'text', text: 'hello' }] }));
        const ignored = await runCLI(['web', 'capture', '--target', PANE, '--mode', 'text', '--json'], {
            port: server.port
        });
        expect(ignored.code).toBe(0);
        expect(ignored.stdout).toBe('hello\n');

        for (const mode of ['dom', 'all', 'pdf']) {
            const before = server.requests.length;
            const rejected = await runCLI(['web', 'capture', '--target', PANE, '--mode', mode], {
                port: server.port
            });
            expect(rejected.code).toBe(1);
            expect(rejected.stderr).toBe(
                `kelpi web capture: unknown --mode '${mode}' (allowed: meta, text, screenshot)\n`
            );
            expect(server.requests).toHaveLength(before);
        }
    });

    it('enforces the target scope rule client-side', async () => {
        const label = await runCLI(['web', 'capture', '--target', 'somelabel'], { port: server.port });
        expect(label.code).toBe(1);
        expect(label.stderr).toBe(
            'kelpi web capture: --target by label requires --workspace <name-or-id> when called outside a Kelpi pane\n'
        );

        const none = await runCLI(['web', 'capture'], { port: server.port });
        expect(none.code).toBe(1);
        // The error names the variable the CLI reads (cli.md §15.1); the pre-rename NEX_PANE_ID
        // wording pointed users at a variable nothing honours (#46).
        expect(none.stderr).toBe('kelpi web capture: no --target supplied and KELPI_PANE_ID is not set\n');
        expect(server.requests).toHaveLength(0);
    });

    it('protects a `--`-terminated payload from the flag parser', async () => {
        server.respond(() => ({ lines: [{ ok: true, value: '--submit' }] }));
        const result = await runCLI(['web', 'type', '--target', PANE, 'css:#i', '--', '--submit'], {
            port: server.port
        });
        expect(result.code).toBe(0);
        expect(await lastRequest()).toEqual({
            command: 'web-type',
            selector: 'css:#i',
            text: '--submit',
            target: PANE
        });
    });

    it('prints console lines on stdout and the cursor notice on stderr', async () => {
        server.respond(() => ({
            lines: [
                {
                    ok: true,
                    lines: [
                        { seq: 0, level: 'log', message: 'first' },
                        { seq: 1, level: 'error', message: 'boom' }
                    ],
                    dropped: 3,
                    next_since: 2
                }
            ]
        }));
        const result = await runCLI(['web', 'console', '--target', PANE], { port: server.port });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('[0] log: first\n[1] error: boom\n');
        expect(result.stderr).toBe(
            '(dropped 3 lines before this batch — buffer was full)\n(next_since=2)\n'
        );
    });

    it('streams with --follow: drain first, then one line per event', async () => {
        server.respond(() => ({
            lines: [{ ok: true, follow: true, lines: [{ seq: 0, level: 'log', message: 'before' }], next_since: 1 }],
            keepOpen: true
        }));
        const running = runCLI(['web', 'console', '--target', PANE, '--follow'], {
            port: server.port,
            timeoutMs: 15_000
        });
        // Give the CLI a moment to connect and drain, then push two live lines and hang up.
        await new Promise((resolve) => setTimeout(resolve, 400));
        server.push({ seq: 1, level: 'warn', message: 'live' });
        server.push({ seq: 2, level: 'error', message: 'later' });
        await new Promise((resolve) => setTimeout(resolve, 200));
        for (const socket of [...server.open]) socket.end();

        const result = await running;
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('[0] log: before\n[1] warn: live\n[2] error: later\n');
        expect(result.stderr).toContain('(following — press Ctrl-C to stop)');
        expect(await lastRequest()).toEqual({ command: 'web-console', follow: true, target: PANE });
    }, 30_000);

    it('exits 128+SIGINT on Ctrl-C, after printing what it already had', async () => {
        server.respond(() => ({
            lines: [{ ok: true, follow: true, lines: [{ seq: 0, level: 'log', message: 'before' }], next_since: 1 }],
            keepOpen: true
        }));
        const result = await runCLI(['web', 'console', '--target', PANE, '--follow'], {
            port: server.port,
            sigintAfterMs: 600,
            timeoutMs: 15_000
        });
        expect(result.code).toBe(130);
        expect(result.stdout).toBe('[0] log: before\n');
        // The server saw the client hang up, which is what releases the held reply handle.
        expect(server.open).toHaveLength(0);
    }, 30_000);

    it('exits 1 when the follow drain itself fails', async () => {
        server.respond(() => ({ lines: [{ ok: false, error: 'pane is not a web pane' }], keepOpen: true }));
        const result = await runCLI(['web', 'console', '--target', PANE, '--follow'], {
            port: server.port,
            timeoutMs: 15_000
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toBe('kelpi web console: pane is not a web pane\n');
    }, 30_000);
});

describe('web printers', () => {
    it('prints url TAB title, and just the url when the title is empty', async () => {
        server.respond(() => ({ lines: [{ ok: true, url: 'https://e.com/a', title: 'Live' }] }));
        const withTitle = await runCLI(['web', 'url', '--target', PANE], { port: server.port });
        expect(withTitle.stdout).toBe('https://e.com/a\tLive\n');

        server.respond(() => ({ lines: [{ ok: true, url: 'https://e.com/a', title: '' }] }));
        const without = await runCLI(['web', 'url', '--target', PANE], { port: server.port });
        expect(without.stdout).toBe('https://e.com/a\n');
    });

    it('renders each capture mode the shipped flag set can reach', async () => {
        server.respond(() => ({ lines: [{ ok: true, mode: 'meta', url: 'https://e.com', title: 'E', byte_count: 12 }] }));
        const meta = await runCLI(['web', 'capture', '--target', PANE], { port: server.port });
        expect(meta.stdout).toBe('url:    https://e.com\ntitle:  E\nbytes:  12\n');

        server.respond(() => ({ lines: [{ ok: true, mode: 'screenshot', png_base64: 'iVBORw0KGgo=' }] }));
        const shot = await runCLI(['web', 'capture', '--target', PANE, '--mode', 'screenshot'], {
            port: server.port
        });
        expect(shot.stdout).toBe('iVBORw0KGgo=\n');
    });

    it('renders the tabs table with the active marker', async () => {
        server.respond(() => ({
            lines: [
                {
                    ok: true,
                    tabs: [
                        { index: 0, active: true, title: 'Home', url: 'https://a/' },
                        { index: 1, active: false, title: '', url: 'https://b/' }
                    ]
                }
            ]
        }));
        const result = await runCLI(['web', 'tabs', '--target', PANE], { port: server.port });
        expect(result.stdout.split('\n')[0]).toBe('IDX  A  TITLE                    URL');
        expect(result.stdout.split('\n')[1]).toBe('0    *  Home                      https://a/');
    });

    it('renders the read verbs, including an empty-but-present attribute', async () => {
        server.respond(() => ({ lines: [{ ok: true, count: 3 }] }));
        expect((await runCLI(['web', 'count', '--target', PANE, 'css:li'], { port: server.port })).stdout).toBe('3\n');

        server.respond(() => ({ lines: [{ ok: true, present: true, value: '' }] }));
        const empty = await runCLI(['web', 'attr', '--target', PANE, 'css:#a', 'disabled'], { port: server.port });
        expect(empty.code).toBe(0);
        expect(empty.stdout).toBe('\n');

        server.respond(() => ({ lines: [{ ok: true, present: false, value: null }] }));
        const absent = await runCLI(['web', 'attr', '--target', PANE, 'css:#a', 'disabled'], { port: server.port });
        expect(absent.code).toBe(1);
        expect(absent.stdout).toBe('');

        server.respond(() => ({ lines: [{ ok: true, outer_html: '<b>hi</b>' }] }));
        expect(
            (await runCLI(['web', 'dom', '--target', PANE, 'css:b', '--max-bytes', '100'], { port: server.port })).stdout
        ).toBe('<b>hi</b>\n');
        expect(await lastRequest()).toEqual({ command: 'web-q-dom', selector: 'css:b', max_bytes: 100, target: PANE });
    });

    it('renders the actuator acks', async () => {
        server.respond(() => ({ lines: [{ ok: true, text: 'Sign in' }] }));
        expect((await runCLI(['web', 'click', '--target', PANE, 'css:#go'], { port: server.port })).stdout).toBe(
            'clicked: "Sign in"\n'
        );

        server.respond(() => ({ lines: [{ ok: true, label: 'Blue', value: 'b' }] }));
        expect(
            (await runCLI(['web', 'select', '--target', PANE, 'css:#c', 'b'], { port: server.port })).stdout
        ).toBe('selected: Blue\n');

        server.respond(() => ({ lines: [{ ok: true }] }));
        expect((await runCLI(['web', 'hover', '--target', PANE, 'css:#c'], { port: server.port })).stdout).toBe(
            'hovered\n'
        );
        expect(
            (await runCLI(['web', 'scroll', '--target', PANE, 'css:#c', '--bottom', '--smooth'], { port: server.port }))
                .stdout
        ).toBe('scrolled\n');
        expect(await lastRequest()).toEqual({
            command: 'web-scroll',
            selector: 'css:#c',
            block: 'end',
            behavior: 'smooth',
            target: PANE
        });

        server.respond(() => ({ lines: [{ ok: true, key: 'Enter' }] }));
        expect((await runCLI(['web', 'key', '--target', PANE, 'Enter'], { port: server.port })).stdout).toBe(
            'key: Enter\n'
        );

        server.respond(() => ({ lines: [{ ok: true, condition: 'visible', waited_ms: 250 }] }));
        const waited = await runCLI(
            ['web', 'wait', '--target', PANE, '--selector', 'css:#late', '--for', 'visible', '--timeout', '2'],
            { port: server.port }
        );
        expect(waited.stdout).toBe('matched visible in 250 ms\n');
        expect(await lastRequest()).toEqual({
            command: 'web-wait',
            timeout_ms: 2000,
            selector: 'css:#late',
            for: 'visible',
            target: PANE
        });
    });

    it('renders inspect arm / disarm states', async () => {
        server.respond(() => ({ lines: [{ ok: true, armed: true, pane_id: PANE, send_to: 'coder', submit: true }] }));
        expect((await runCLI(['web', 'inspect', '--target', PANE, '--send-to', 'coder', '--submit'], { port: server.port })).stdout).toBe(
            `inspect armed: ${PANE} → will paste to coder (+submit)\n`
        );

        server.respond(() => ({ lines: [{ ok: true, armed: false, pane_id: PANE }] }));
        expect((await runCLI(['web', 'inspect', '--target', PANE, '--disarm'], { port: server.port })).stdout).toBe(
            `inspect disarmed: ${PANE}\n`
        );

        server.respond(() => ({ lines: [{ ok: true, results: [] }] }));
        expect((await runCLI(['web', 'inspect-result', '--target', PANE], { port: server.port })).stdout).toBe(
            '(no pending inspect results)\n'
        );
    });

    it('renders private + cookies, and exits 1 when no cookie matched', async () => {
        server.respond(() => ({ lines: [{ ok: true, private: true, changed: false, pane_id: PANE }] }));
        expect((await runCLI(['web', 'private', 'on', '--target', PANE], { port: server.port })).stdout).toBe(
            `private on: ${PANE} (no change)\n`
        );

        server.respond(() => ({ lines: [{ ok: true, cookies: [] }] }));
        expect((await runCLI(['web', 'cookies', 'list', '--target', PANE], { port: server.port })).stdout).toBe(
            '(no cookies)\n'
        );

        server.respond(() => ({ lines: [{ ok: true, deleted: 2, domain: 'example.com' }] }));
        expect(
            (await runCLI(['web', 'cookies', 'clear', '--target', PANE, '--domain', 'example.com'], { port: server.port }))
                .stdout
        ).toBe('deleted 2 cookies for example.com\n');

        server.respond(() => ({ lines: [{ ok: true, deleted: 0, name: 'sid' }] }));
        const missing = await runCLI(['web', 'cookies', 'delete', 'sid', '--target', PANE], { port: server.port });
        expect(missing.code).toBe(1);
        expect(missing.stdout).toBe("no cookie matched name 'sid'\n");
    });

    it('resolves a local file for tab-new but leaves a bare hostname alone', async () => {
        const home = scratchHome();
        fs.writeFileSync(path.join(home, 'local.html'), '<h1>hi</h1>');
        server.respond(() => ({ lines: [{ ok: true, pane_id: PANE }] }));
        await runCLI(['web', 'tab-new', '--target', PANE, 'local.html', '--no-focus'], {
            port: server.port,
            cwd: home
        });
        expect(String((await lastRequest())['url']).endsWith('/local.html')).toBe(true);
        expect((await lastRequest())['make_active']).toBe(false);

        await runCLI(['web', 'tab-new', '--target', PANE, 'example.com'], { port: server.port, cwd: home });
        expect(await lastRequest()).toEqual({
            command: 'web-tab-new',
            url: 'example.com',
            make_active: true,
            target: PANE
        });
    });
});

/** #324: the csv document actions ride the plugin `document` action like get/edit/save. */
describe('kelpi document csv actions', () => {
    const sent = async (): Promise<{ method: string; args: Record<string, unknown> }> => {
        const request = await lastRequest();
        expect(request).toMatchObject({ command: 'plugin', action: 'document' });
        return JSON.parse(String(request['text'])) as { method: string; args: Record<string, unknown> };
    };

    it('reads a row window with camelCase arguments and prints the result', async () => {
        server.respond(() => ({ lines: [{ ok: true, result: { generation: 'i:0', revision: 3, start: 10, columnStart: 0, columnIDs: [0, 1], rows: [], nextStart: null } }] }));
        const result = await runCLI(['document', 'rows', PANE, '--start', '10', '--count', '20', '--column-start', '2', '--column-count', '3'], { port: server.port });
        expect(result.code).toBe(0);
        expect(await sent()).toEqual({ method: 'csv-rows', args: { paneID: PANE, start: 10, count: 20, columnStart: 2, columnCount: 3 } });
        expect(JSON.parse(result.stdout)).toMatchObject({ generation: 'i:0', nextStart: null });

        await runCLI(['document', 'rows', '--start', '0', '--count', '1', PANE], { port: server.port });
        expect(await sent()).toEqual({ method: 'csv-rows', args: { paneID: PANE, start: 0, count: 1 } });
    });

    it('sends a validated edit batch from --ops or --ops-file', async () => {
        const home = scratchHome();
        server.respond(() => ({ lines: [{ ok: true, result: { paneID: PANE } }] }));
        const ops = [{ op: 'set-cell', row: 1, column: 0, value: 'x' }, { op: 'insert-rows', at: 2, count: 1 }];
        await runCLI(['document', 'csv-edit', PANE, '--generation', 'i:4', '--ops', JSON.stringify(ops)], { port: server.port });
        expect(await sent()).toEqual({ method: 'csv-edit', args: { paneID: PANE, generation: 'i:4', ops } });

        fs.writeFileSync(path.join(home, 'ops.json'), JSON.stringify([{ op: 'undo' }]));
        await runCLI(['document', 'csv-edit', PANE, '--generation', 'i:5', '--ops-file', 'ops.json'], { port: server.port, cwd: home });
        expect(await sent()).toEqual({ method: 'csv-edit', args: { paneID: PANE, generation: 'i:5', ops: [{ op: 'undo' }] } });
    });

    it('sends sort, find, header-row and csv-state', async () => {
        server.respond(() => ({ lines: [{ ok: true, result: {} }] }));
        await runCLI(['document', 'sort', PANE, '--column', '2', '--direction', 'desc'], { port: server.port });
        expect(await sent()).toEqual({ method: 'csv-sort', args: { paneID: PANE, column: 2, direction: 'desc' } });
        await runCLI(['document', 'sort', PANE, '--clear'], { port: server.port });
        expect(await sent()).toEqual({ method: 'csv-sort', args: { paneID: PANE, column: null } });
        await runCLI(['document', 'find', PANE, '--query', 'needle'], { port: server.port });
        expect(await sent()).toEqual({ method: 'csv-find', args: { paneID: PANE, query: 'needle' } });
        await runCLI(['document', 'header-row', PANE, 'off'], { port: server.port });
        expect(await sent()).toEqual({ method: 'csv-header-row', args: { paneID: PANE, on: false } });
        await runCLI(['document', 'csv-state', PANE], { port: server.port });
        expect(await sent()).toEqual({ method: 'csv-state', args: { paneID: PANE } });
    });

    it.each([
        [['rows', PANE, '--count', '5'], '--start is required.'],
        [['rows', PANE, '--start', '0', '--count', '501'], '--count is at most 500.'],
        [['rows', PANE, '--start', '-1', '--count', '5'], '--start must be a non-negative integer.'],
        [['csv-edit', PANE, '--ops', '[{"op":"undo"}]'], '--generation is required'],
        [['csv-edit', PANE, '--generation', 'g', '--ops', '[]'], 'CSV_INVALID: ops is empty'],
        [['csv-edit', PANE, '--generation', 'g', '--ops', '[{"op":"merge"}]'], 'CSV_INVALID: unknown op'],
        [['csv-edit', PANE, '--generation', 'g', '--ops', 'not json'], '--ops must be a JSON array'],
        [['csv-edit', PANE, '--generation', 'g', '--revision', 'r', '--ops', '[{"op":"undo"}]'], 'csv-edit is guarded by --generation'],
        [['sort', PANE], 'Provide exactly one of --column or --clear.'],
        [['sort', PANE, '--column', '1', '--direction', 'up'], '--direction must be asc or desc.'],
        [['header-row', PANE, 'yes'], 'Header row must be on or off.'],
        [['find', PANE], '--query is required.']
    ])('refuses %j locally without sending', async (args, message) => {
        const result = await runCLI(['document', ...args], { port: server.port });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(message);
        expect(server.requests).toHaveLength(0);
    });

    it('lists the csv actions in its help', async () => {
        const help = await runCLI(['document', '--help'], { port: server.port });
        expect(help.stdout).toContain('rows <pane-id> --start N --count M');
        expect(help.stdout).toContain("csv-edit <pane-id> --generation <token> (--ops '<json>' | --ops-file <path>)");
        expect(help.stdout).toContain('wait up to 10 minutes');
        expect(help.stdout).toContain('kelpi pane list --json');
        const usage = await runCLI(['--help']);
        expect(usage.stderr).toContain('kelpi document get|watch|edit|save|refresh|mode|csv-state|rows|');
    });

    it('takes a csv flag value that looks like a refused flag as the value it is', async () => {
        server.respond(() => ({ lines: [{ ok: true, result: {} }] }));
        const result = await runCLI(['document', 'find', PANE, '--query', '--file'], { port: server.port });
        expect(result.code).toBe(0);
        expect(await sent()).toEqual({ method: 'csv-find', args: { paneID: PANE, query: '--file' } });
    });

    it('refuses an --ops-file over the request cap, with a hint to split it, and one it cannot read, as such', async () => {
        const home = scratchHome();
        const op = { op: 'set-cell', row: 1, column: 0, value: 'x'.repeat(1000) };
        fs.writeFileSync(path.join(home, 'big.json'), JSON.stringify(Array.from({ length: 300 }, () => op)));
        const big = await runCLI(['document', 'csv-edit', PANE, '--generation', 'g', '--ops-file', 'big.json'], { port: server.port, cwd: home });
        expect(big.code).toBe(1);
        expect(big.stderr).toContain('Edit batch is over the 256 KiB a request carries; split it into several csv-edit calls.');

        fs.mkdirSync(path.join(home, 'ops-dir'));
        const unreadable = await runCLI(['document', 'csv-edit', PANE, '--generation', 'g', '--ops-file', 'ops-dir'], { port: server.port, cwd: home });
        expect(unreadable.code).toBe(1);
        expect(unreadable.stderr).toContain('Could not read --ops-file ops-dir');
        expect(unreadable.stderr).not.toContain('must be a JSON array');

        fs.writeFileSync(path.join(home, 'bad.json'), 'not json');
        const bad = await runCLI(['document', 'csv-edit', PANE, '--generation', 'g', '--ops-file', 'bad.json'], { port: server.port, cwd: home });
        expect(bad.stderr).toContain('--ops-file must be a JSON array of csv edit ops.');
        expect(server.requests).toHaveLength(0);
    });
});

describe('caller-pane scoping', () => {
    it.each([
        [['pane', 'close'], 'pane-close'],
        [['pane', 'capture'], 'pane-capture'],
        [['pane', 'list', '--current'], 'pane-list'],
        [['pane', 'move', 'left'], 'pane-move'],
        [['pane', 'move-to-workspace', '--to-workspace', 'beta'], 'pane-move-to-workspace'],
        [['layout', 'cycle'], 'layout-cycle'],
        [['layout', 'select', 'tiled'], 'layout-select']
    ])('exits 0 silently outside a pane: kelpi %s', async (args) => {
        const result = await runCLI(args, { port: server.port });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
        expect(server.requests).toHaveLength(0);
    });

    it('uses the caller pane as the subject when KELPI_PANE_ID is set', async () => {
        server.respond(() => ({ lines: [{ ok: true, pane_id: PANE, panes: [], text: '' }] }));
        await runCLI(['pane', 'capture'], { port: server.port, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'pane-capture', pane_id: PANE });
        await runCLI(['pane', 'list', '--current', '--json'], { port: server.port, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'pane-list', pane_id: PANE, scope: 'current' });
        await runCLI(['layout', 'select', 'tiled'], { port: server.port, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'layout-select', pane_id: PANE, name: 'tiled' });
    });

    it('forwards the caller pane only as a label scope for `--target` commands', async () => {
        server.respond(() => ({ lines: [{ ok: true, pane_id: OTHER }] }));
        await runCLI(['pane', 'close', '--target', 'worker-1'], { port: server.port, paneID: PANE });
        expect(await lastRequest()).toEqual({ command: 'pane-close', target: 'worker-1', pane_id: PANE });
    });

    it('tells the user which flag to pass when there is no caller pane', async () => {
        const result = await runCLI(['pane', 'split'], { port: server.port });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
            'kelpi pane split: requires --target <name-or-uuid> or --workspace <name-or-id> when called from outside a Kelpi pane'
        );
    });
});

describe('doctor', () => {
    it('reports a passing ping and exits 0 despite WARNs', async () => {
        server.respond(() => ({ lines: [{ ok: true, version: '0.1.0', build: '1', pid: 4242, protocol: 1 }] }));
        const result = await runCLI(['doctor', '--json'], { port: server.port });
        expect(result.code).toBe(0);
        const report = JSON.parse(result.stdout) as {
            ok: boolean;
            checks: { name: string; status: string; detail: string }[];
        };
        expect(report.ok).toBe(true);
        const byName = new Map(report.checks.map((check) => [check.name, check]));
        expect(byName.get('transport')?.detail).toContain(`127.0.0.1:${String(server.port)}`);
        expect(byName.get('resolve')?.status).toBe('pass');
        expect(byName.get('ping')?.detail).toBe('round-trip ok (app pid 4242)');
        // TCP ⇒ the daemon is "remote", so the process check cannot look at it.
        expect(byName.get('process')?.status).toBe('skip');
        // Separate artifacts ⇒ advisory WARN, never a FAIL.
        expect(byName.get('version')?.status).toBe('warn');
        expect(byName.get('hooks')?.status).toBe('skip');
        expect(byName.get('codex-hooks')?.status).toBe('skip');
    });

    it('fails when nothing answers, and still exits 0-free of stack traces', async () => {
        const port = await deadPort();
        const result = await runCLI(['doctor', '--json'], { port });
        expect(result.code).toBe(1);
        const report = JSON.parse(result.stdout) as { ok: boolean; checks: { name: string; status: string }[] };
        expect(report.ok).toBe(false);
        expect(report.checks.find((check) => check.name === 'ping')?.status).toBe('fail');
    });

    it('uses exit 2 for an unexpected argument', async () => {
        const result = await runCLI(['doctor', 'extra'], { port: server.port });
        expect(result.code).toBe(2);
        expect(result.stderr).toBe('kelpi doctor: unexpected argument: extra\nUsage: kelpi doctor [--json]\n');
    });

    it('passes the process check on a live daemon pid record', async () => {
        const home = scratchHome();
        const runDir = path.join(home, 'run');
        fs.mkdirSync(runDir, { recursive: true });
        // A record naming a process that certainly exists: this test runner.
        fs.writeFileSync(
            path.join(runDir, `daemon-v${PROTOCOL_VERSION}.pid`),
            JSON.stringify({ pid: process.pid, protocol: PROTOCOL_VERSION, started_at: '', version: '0.1.0' })
        );
        // Unix transport so the check runs at all; the socket check FAILs, which is fine —
        // we are asserting the process check alone.
        const result = await runCLI(['doctor', '--json'], { cwd: home, env: { KELPID_RUN_DIR: runDir } });
        const report = JSON.parse(result.stdout) as { checks: { name: string; status: string; detail: string }[] };
        const check = report.checks.find((entry) => entry.name === 'process');
        expect(check?.status).toBe('pass');
        expect(check?.detail).toContain(`kelpid running (pid ${String(process.pid)}`);
    });
});

describe('graft', () => {
    it('prints started entries on stdout and a partial failure on stderr, exit 0', async () => {
        server.respond(() => ({
            lines: [
                {
                    ok: true,
                    started: [{ association_id: 'assoc-1', branch: 'feature', worktree_path: '/tmp/wt' }],
                    partial_error: 'another graft is already active for /repo'
                }
            ]
        }));
        const result = await runCLI(['graft', 'start', '--repo', 'repo'], { port: server.port });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('started feature (assoc-1) at /tmp/wt\n');
        expect(result.stderr).toBe('Partial failure: another graft is already active for /repo\n');
        expect(await lastRequest()).toEqual({ command: 'graft-start', repo: 'repo' });
    });

    it('exits 1 when a stop reports failures', async () => {
        server.respond(() => ({
            lines: [{ ok: true, stopped: ['assoc-1'], failed: [{ association_id: 'assoc-2', error: 'dirty' }] }]
        }));
        const result = await runCLI(['graft', 'stop'], { port: server.port, paneID: PANE });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('stopped assoc-1\n');
        expect(result.stderr).toBe('failed assoc-2: dirty\n');
        expect(await lastRequest()).toEqual({ command: 'graft-stop', pane_id: PANE });
    });

    it('renders an empty status two ways', async () => {
        server.respond(() => ({ lines: [{ ok: true, sessions: [] }] }));
        const human = await runCLI(['graft', 'status'], { port: server.port });
        expect(human.stdout).toBe('No active graft sessions.\n');
        const json = await runCLI(['graft', 'status', '--json'], { port: server.port });
        expect(json.stdout).toBe('[]\n');
    });
});

describe('pane sync', () => {
    it('renders the human summary and strips `ok` under --json', async () => {
        server.respond(() => ({
            lines: [
                {
                    ok: true,
                    active: true,
                    synced_pane_ids: [PANE, OTHER],
                    excluded: [{ id: OTHER, label: 'w2' }],
                    workspace_name: 'alpha',
                    workspace_id: PANE
                }
            ]
        }));
        const human = await runCLI(['pane', 'sync', 'on', '--workspace', 'alpha'], { port: server.port });
        expect(human.stdout).toBe('workspace: alpha\nsync     : on\nsynced   : 2 panes\nexcluded : w2\n');
        expect(await lastRequest()).toEqual({ command: 'pane-sync', action: 'on', workspace: 'alpha' });

        const json = await runCLI(['pane', 'sync', 'exclude', '--target', OTHER, '--json'], {
            port: server.port,
            paneID: PANE
        });
        expect(JSON.parse(json.stdout)).not.toHaveProperty('ok');
        expect(await lastRequest()).toEqual({
            command: 'pane-sync-exclude',
            target: OTHER,
            excluded: true,
            pane_id: PANE
        });
    });

    it('rejects a stray --target on the workspace-wide toggle', async () => {
        const result = await runCLI(['pane', 'sync', 'on', '--target', OTHER], { port: server.port });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('is not valid here (the toggle is workspace-wide)');
        expect(server.requests).toHaveLength(0);
    });
});

describe('workspace create / label / mute', () => {
    it('prints the full reply including ok under --json', async () => {
        server.respond(() => ({ lines: [{ ok: true, workspace_id: PANE, workspace_name: 'alpha', group: 'squad' }] }));
        const result = await runCLI(['workspace', 'create', '--name', 'alpha', '--group', 'squad', '--json'], {
            port: server.port
        });
        expect(JSON.parse(result.stdout)).toEqual({
            ok: true,
            workspace_id: PANE,
            workspace_name: 'alpha',
            group: 'squad'
        });

        const human = await runCLI(['workspace', 'create', '--name', 'alpha', '--group', 'squad'], {
            port: server.port
        });
        expect(human.stdout).toBe(`created workspace alpha (${PANE}) in group squad\n`);
    });

    it('always ships the repo for a worktree create', async () => {
        const home = scratchHome();
        server.respond(() => ({
            lines: [
                {
                    ok: true,
                    workspace_id: PANE,
                    workspace_name: 'Feature',
                    worktree_path: '/tmp/wt/feature',
                    branch: 'feature'
                }
            ]
        }));
        const result = await runCLI(['workspace', 'create', '--worktree', 'feature', '--update-main'], {
            port: server.port,
            cwd: home
        });
        expect(result.stdout).toBe(
            `created workspace Feature (${PANE}) with worktree /tmp/wt/feature on branch feature\n`
        );
        expect(await lastRequest()).toEqual({
            command: 'workspace-create',
            worktree: 'feature',
            update_main: true,
            repo: home
        });
    });

    it('collects repeated label values into one operation', async () => {
        server.respond(() => ({
            lines: [{ ok: true, workspace_id: PANE, workspace_name: 'alpha', labels: ['a', 'b'] }]
        }));
        const result = await runCLI(['workspace', 'label', 'alpha', '--add', 'a', '--add', 'b'], {
            port: server.port
        });
        expect(result.stdout).toBe('alpha labels: a, b\n');
        expect(await lastRequest()).toEqual({
            command: 'workspace-label',
            name: 'alpha',
            label_op: 'add',
            label_values: ['a', 'b']
        });
    });

    it('rejects two operations and points --style at Settings', async () => {
        const both = await runCLI(['workspace', 'label', 'alpha', '--add', 'a', '--clear'], { port: server.port });
        expect(both.code).toBe(1);
        expect(both.stderr).toBe('workspace label requires exactly one of --set / --add / --remove / --clear\n');

        const style = await runCLI(['workspace', 'label', 'alpha', '--add', 'a', '--style', 'blue'], {
            port: server.port
        });
        expect(style.code).toBe(1);
        expect(style.stderr).toContain('--style is not yet supported');
        expect(server.requests).toHaveLength(0);
    });

    it('sends muted on create only when --muted is given, composing with --worktree', async () => {
        const home = scratchHome();
        server.respond((request) => ({
            lines: [{ ok: true, workspace_id: PANE, workspace_name: 'child', muted: request['muted'] === true }]
        }));
        const quiet = await runCLI(['workspace', 'create', '--name', 'child', '--muted'], { port: server.port });
        expect(quiet.code).toBe(0);
        expect(quiet.stdout).toBe(`created workspace child (${PANE})\n`);
        expect(await lastRequest()).toEqual({ command: 'workspace-create', name: 'child', muted: true });

        await runCLI(['workspace', 'create', '--name', 'child'], { port: server.port });
        expect(await lastRequest()).toEqual({ command: 'workspace-create', name: 'child' });

        await runCLI(['workspace', 'create', '--worktree', 'feature', '--muted', '--group', 'squad'], {
            port: server.port,
            cwd: home
        });
        // With a group and no --repo, the source is left to the group's repository and the
        // cwd rides as the `path` fallback (app-state-core §5.5).
        expect(await lastRequest()).toEqual({
            command: 'workspace-create',
            group: 'squad',
            muted: true,
            worktree: 'feature',
            path: home
        });
    });

    describe('a group’s default repository (app-state-core §5.5)', () => {
        it('leaves update main to the group unless a flag says otherwise', async () => {
            const home = scratchHome();
            server.respond(() => ({
                lines: [
                    {
                        ok: true,
                        workspace_id: PANE,
                        workspace_name: 'fix',
                        worktree_path: '/tmp/wt/fix',
                        branch: 'fix',
                        update_main: true,
                        group: 'kelpi'
                    }
                ]
            }));
            const result = await runCLI(['workspace', 'create', '--group', 'kelpi', '--worktree', 'fix'], {
                port: server.port,
                cwd: home
            });
            expect(result.stdout).toBe(
                `created workspace fix (${PANE}) in group kelpi with worktree /tmp/wt/fix on branch fix off the latest main\n`
            );
            expect(await lastRequest()).toEqual({ command: 'workspace-create', group: 'kelpi', worktree: 'fix', path: home });

            await runCLI(['workspace', 'create', '--group', 'kelpi', '--worktree', 'fix', '--no-update-main'], {
                port: server.port,
                cwd: home
            });
            expect(await lastRequest()).toMatchObject({ update_main: false });

            await runCLI(['workspace', 'create', '--group', 'kelpi', '--worktree', 'fix', '--update-main'], {
                port: server.port,
                cwd: home
            });
            expect(await lastRequest()).toMatchObject({ update_main: true });
        });

        it('sends an explicit repo (made absolute) and --no-repo, and refuses contradictory flags', async () => {
            const home = scratchHome();
            server.respond(() => ({
                lines: [{ ok: true, workspace_id: PANE, workspace_name: 'dev', group: 'kelpi', repo_path: '/code/kelpi' }]
            }));
            const associated = await runCLI(['workspace', 'create', '--name', 'dev', '--group', 'kelpi'], {
                port: server.port
            });
            expect(associated.stdout).toBe(`created workspace dev (${PANE}) in group kelpi with repo /code/kelpi\n`);

            await runCLI(['workspace', 'create', '--name', 'dev', '--repo', 'sub/repo'], { port: server.port, cwd: home });
            expect(await lastRequest()).toEqual({
                command: 'workspace-create',
                name: 'dev',
                repo: path.join(fs.realpathSync(home), 'sub/repo')
            });

            // `--path` is made absolute too: with `--group --worktree` on a repo-less group it is
            // the worktree's source, and the daemon's cwd is not the shell's.
            await runCLI(['workspace', 'create', '--name', 'dev', '--group', 'kelpi', '--worktree', 'wt', '--path', 'src/app'], {
                port: server.port,
                cwd: home
            });
            expect(await lastRequest()).toEqual({
                command: 'workspace-create',
                name: 'dev',
                group: 'kelpi',
                worktree: 'wt',
                path: path.join(fs.realpathSync(home), 'src/app')
            });

            await runCLI(['workspace', 'create', '--name', 'dev', '--group', 'kelpi', '--no-repo'], { port: server.port });
            expect(await lastRequest()).toEqual({
                command: 'workspace-create',
                name: 'dev',
                group: 'kelpi',
                group_defaults: false
            });

            const before = server.requests.length;
            const both = await runCLI(['workspace', 'create', '--worktree', 'x', '--update-main', '--no-update-main'], {
                port: server.port
            });
            expect(both.code).toBe(1);
            expect(both.stderr).toBe("workspace create can't take both --update-main and --no-update-main\n");
            const repoBoth = await runCLI(['workspace', 'create', '--repo', '/r', '--no-repo'], { port: server.port });
            expect(repoBoth.code).toBe(1);
            expect(server.requests).toHaveLength(before);
        });

        it('sets, clears and switches a group’s repository with `group set-repo`', async () => {
            const home = scratchHome();
            server.respond((request) => ({
                lines: [
                    {
                        ok: true,
                        group_id: PANE,
                        group_name: 'kelpi',
                        repo: request['clear'] === true ? null : { id: OTHER, name: 'kelpi', path: '/code/kelpi' },
                        create_worktree: request['create_worktree'] === true
                    }
                ]
            }));
            const set = await runCLI(['group', 'set-repo', 'kelpi', 'code/kelpi', '--worktree'], {
                port: server.port,
                cwd: home
            });
            expect(set.code).toBe(0);
            expect(set.stdout).toBe('group kelpi repo: /code/kelpi (new workspaces create a worktree from latest main)\n');
            expect(await lastRequest()).toEqual({
                command: 'group-set-repo',
                name: 'kelpi',
                repo: path.join(fs.realpathSync(home), 'code/kelpi'),
                create_worktree: true
            });

            const none = await runCLI(['group', 'set-repo', 'kelpi', '--none'], { port: server.port });
            expect(none.stdout).toBe('group kelpi repo: none\n');
            expect(await lastRequest()).toEqual({ command: 'group-set-repo', name: 'kelpi', clear: true });

            await runCLI(['group', 'set-repo', 'kelpi', '--no-worktree', '--json'], { port: server.port });
            expect(await lastRequest()).toEqual({ command: 'group-set-repo', name: 'kelpi', create_worktree: false });

            const before = server.requests.length;
            expect((await runCLI(['group', 'set-repo', 'kelpi'], { port: server.port })).code).toBe(1);
            expect((await runCLI(['group', 'set-repo', 'kelpi', '/r', '--none'], { port: server.port })).code).toBe(1);
            expect((await runCLI(['group', 'set-repo', 'kelpi', '--none', '--worktree'], { port: server.port })).code).toBe(1);
            expect(server.requests).toHaveLength(before);
        });

        it('exits 1 with the daemon’s message when set-repo is refused', async () => {
            server.respond(() => ({ lines: [{ ok: false, error: '/tmp/plain is not inside a git repository' }] }));
            const result = await runCLI(['group', 'set-repo', 'kelpi', '/tmp/plain'], { port: server.port });
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('/tmp/plain is not inside a git repository');
        });

        it('shows the repository in `group list`', async () => {
            server.respond(() => ({
                lines: [
                    {
                        ok: true,
                        groups: [
                            {
                                id: PANE,
                                name: 'kelpi',
                                workspaces: [],
                                repo: { id: OTHER, name: 'kelpi', path: '/code/kelpi' },
                                create_worktree: true
                            }
                        ]
                    }
                ]
            }));
            const result = await runCLI(['group', 'list'], { port: server.port });
            expect(result.stdout).toContain('REPO');
            expect(result.stdout).toContain('kelpi +worktree');
        });
    });

    it('fails --muted loudly when the daemon did not apply it (an older daemon drops the field)', async () => {
        server.respond(() => ({ lines: [{ ok: true, workspace_id: PANE, workspace_name: 'child' }] }));
        const plain = await runCLI(['workspace', 'create', '--name', 'child', '--muted'], { port: server.port });
        expect(plain.code).toBe(1);
        expect(plain.stdout).toBe('');
        expect(plain.stderr).toBe(
            `kelpi workspace create: the daemon did not apply --muted; restart it on this build (workspace child (${PANE}) was created unmuted)\n`
        );

        // --json still prints the reply for a script to read, and still fails.
        const json = await runCLI(['workspace', 'create', '--name', 'child', '--muted', '--json'], { port: server.port });
        expect(json.code).toBe(1);
        expect(JSON.parse(json.stdout)).toEqual({ ok: true, workspace_id: PANE, workspace_name: 'child' });
        expect(json.stderr).toContain('did not apply --muted');

        // Without --muted the same reply is simply a success.
        const unmuted = await runCLI(['workspace', 'create', '--name', 'child'], { port: server.port });
        expect(unmuted.code).toBe(0);
    });

    it('mutes by default, unmutes with --off and toggles with --toggle', async () => {
        server.respond((request) => ({
            lines: [
                {
                    ok: true,
                    workspace_id: PANE,
                    workspace_name: 'child',
                    muted: request['muted'] ?? false
                }
            ]
        }));
        const on = await runCLI(['workspace', 'mute', 'child'], { port: server.port });
        expect(on.code).toBe(0);
        expect(on.stdout).toBe('child: notifications muted\n');
        expect(await lastRequest()).toEqual({ command: 'workspace-mute', name: 'child', muted: true });

        const off = await runCLI(['workspace', 'mute', '--off', 'child'], { port: server.port });
        expect(off.stdout).toBe('child: notifications unmuted\n');
        expect(await lastRequest()).toEqual({ command: 'workspace-mute', name: 'child', muted: false });

        const toggle = await runCLI(['workspace', 'mute', 'child', '--toggle', '--json'], { port: server.port });
        expect(JSON.parse(toggle.stdout)).toEqual({
            ok: true,
            workspace_id: PANE,
            workspace_name: 'child',
            muted: false
        });
        expect(await lastRequest()).toEqual({ command: 'workspace-mute', name: 'child' });
    });

    it('rejects --off with --toggle, a missing name and a stray argument before sending', async () => {
        const both = await runCLI(['workspace', 'mute', 'child', '--off', '--toggle'], { port: server.port });
        expect(both.code).toBe(1);
        expect(both.stderr).toBe("workspace mute can't take both --off and --toggle\n");

        const missing = await runCLI(['workspace', 'mute'], { port: server.port });
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain('kelpi workspace mute <name-or-id>');

        const stray = await runCLI(['workspace', 'mute', 'child', 'extra'], { port: server.port });
        expect(stray.code).toBe(1);
        expect(stray.stderr).toContain("unexpected argument 'extra'");
        expect(server.requests).toHaveLength(0);
    });

    it('exits non-zero with the daemon error for an unknown workspace', async () => {
        server.respond(() => ({ lines: [{ ok: false, error: "no workspace matches 'ghost'" }] }));
        const result = await runCLI(['workspace', 'mute', 'ghost'], { port: server.port });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("no workspace matches 'ghost'");
    });
});

describe('workspace rename', () => {
    const renamed = (request: Record<string, unknown>): ServerReply => ({
        lines: [{ ok: true, workspace_id: PANE, workspace_name: request['new_name'], old_name: 'alpha' }]
    });

    it('sends name and new_name, waits for the reply and prints what changed', async () => {
        server.respond(renamed);
        const result = await runCLI(['workspace', 'rename', 'alpha', 'auth refactor'], { port: server.port });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(`renamed workspace alpha to auth refactor (${PANE})\n`);
        expect(result.stderr).toBe('');
        expect(await lastRequest()).toEqual({ command: 'workspace-rename', name: 'alpha', new_name: 'auth refactor' });
    });

    it('passes an id through untouched and trims the new name before sending', async () => {
        server.respond(renamed);
        const result = await runCLI(['workspace', 'rename', PANE, '  beta  '], { port: server.port });
        expect(result.code).toBe(0);
        expect(await lastRequest()).toEqual({ command: 'workspace-rename', name: PANE, new_name: 'beta' });
    });

    it('prints the full reply including ok under --json, wherever the flag sits', async () => {
        server.respond(renamed);
        const result = await runCLI(['workspace', 'rename', '--json', 'alpha', 'beta'], { port: server.port });
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            ok: true,
            workspace_id: PANE,
            workspace_name: 'beta',
            old_name: 'alpha'
        });
    });

    it('says so when the workspace already had that name', async () => {
        server.respond(() => ({ lines: [{ ok: true, workspace_id: PANE, workspace_name: 'alpha', old_name: 'alpha' }] }));
        const result = await runCLI(['workspace', 'rename', 'alpha', 'alpha'], { port: server.port });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(`workspace alpha (${PANE}) already has that name\n`);
    });

    it('exits 1 with the daemon error for a missing or ambiguous workspace', async () => {
        server.respond(() => ({ lines: [{ ok: false, error: 'workspace not found: ghost' }] }));
        const missing = await runCLI(['workspace', 'rename', 'ghost', 'x'], { port: server.port });
        expect(missing.code).toBe(1);
        expect(missing.stdout).toBe('');
        expect(missing.stderr).toBe('kelpi workspace rename: workspace not found: ghost\n');

        server.respond(() => ({ lines: [{ ok: false, error: 'workspace name is ambiguous: dup (use the id)' }] }));
        const ambiguous = await runCLI(['workspace', 'rename', 'dup', 'x'], { port: server.port });
        expect(ambiguous.code).toBe(1);
        expect(ambiguous.stderr).toBe('kelpi workspace rename: workspace name is ambiguous: dup (use the id)\n');
    });

    it('rejects an empty or whitespace-only new name before sending', async () => {
        for (const blank of ['', '   ']) {
            const result = await runCLI(['workspace', 'rename', 'alpha', blank], { port: server.port });
            expect(result.code).toBe(1);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('kelpi workspace rename: the new name cannot be empty\n');
        }
        expect(server.requests).toHaveLength(0);
    });

    it('prints usage and exits 1 for missing arguments, an unknown option and a stray argument', async () => {
        const none = await runCLI(['workspace', 'rename'], { port: server.port });
        expect(none.code).toBe(1);
        expect(none.stderr).toContain('kelpi workspace rename <name-or-id> <new-name> [--json]');

        const one = await runCLI(['workspace', 'rename', 'alpha'], { port: server.port });
        expect(one.code).toBe(1);
        expect(one.stderr).toContain('kelpi workspace rename <name-or-id> <new-name> [--json]');

        const option = await runCLI(['workspace', 'rename', 'alpha', '--force'], { port: server.port });
        expect(option.code).toBe(1);
        expect(option.stderr).toContain('kelpi workspace rename: unknown option --force');

        // A leading space does not smuggle a dash past the check: the new name is trimmed.
        const dashedCases: [string[], string][] = [
            [['alpha', '-draft'], '-draft'],
            [['alpha', ' -draft'], ' -draft'],
            [[' -x', 'beta'], ' -x']
        ];
        for (const [argv, flag] of dashedCases) {
            const dashed = await runCLI(['workspace', 'rename', ...argv], { port: server.port });
            expect(dashed.code).toBe(1);
            expect(dashed.stderr).toContain(`kelpi workspace rename: unknown option ${flag}\n`);
            expect(dashed.stderr).toContain('kelpi workspace rename <name-or-id> <new-name> [--json]');
        }

        const stray = await runCLI(['workspace', 'rename', 'alpha', 'auth', 'refactor'], { port: server.port });
        expect(stray.code).toBe(1);
        expect(stray.stderr).toContain("unexpected argument 'refactor'");
        expect(stray.stderr).toContain('quote a new name that contains spaces');
        expect(server.requests).toHaveLength(0);
    });

    it('fails loudly against a daemon too old to know the verb', async () => {
        server.respond(() => ({ silent: true }));
        const result = await runCLI(['workspace', 'rename', 'alpha', 'beta'], { port: server.port });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('kelpi workspace rename: no response from Kelpi (upgrade required?)');
    });

    it('is listed in workspace --help and has its own --help', async () => {
        const group = await runCLI(['workspace', '--help'], { port: server.port });
        expect(group.code).toBe(0);
        expect(group.stdout).toContain('list|create|move|delete|profile|label|mute|rename');
        expect(group.stdout).toMatch(/^ {2}rename {4}Rename a workspace\.$/m);

        const own = await runCLI(['workspace', 'rename', '--help'], { port: server.port });
        expect(own.code).toBe(0);
        expect(own.stdout).toContain('kelpi workspace rename <name-or-id> <new-name> [--json]');
        expect(own.stdout).toContain('old_name');

        // The global usage goes to stderr even for --help (the dispatcher test pins that quirk).
        const global = await runCLI(['--help'], { port: server.port });
        expect(global.stderr).toContain('kelpi workspace rename <name-or-id> <new-name> [--json]');

        const unknown = await runCLI(['workspace', 'retitle'], { port: server.port });
        expect(unknown.code).toBe(1);
        expect(unknown.stderr).toContain('Valid actions: list, create, move, delete, profile, label, mute, rename');
        expect(server.requests).toHaveLength(0);
    });
});
